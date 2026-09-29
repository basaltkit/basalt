import type { AccessStore, Delegation, DelegationStore, TemporaryGrant, TemporaryGrantStore } from '@basaltkit/permissions'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/permissions-prisma'

/**
 * Prisma-backed implementation of the `@basaltkit/permissions` `AccessStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `PermUserRole`, `PermUserPermission` and
 * `PermRolePermission` models (see the bundled `prisma/schema.prisma`) — plus
 * `PermTemporaryGrant` and `PermDelegation` for the durable
 * `TemporaryGrantStore` / `DelegationStore`.
 *
 * Role assignments and permission grants are sets — every write is a
 * `createMany({ skipDuplicates: true })`, so re-granting is a harmless no-op.
 * The production counterpart to `@basaltkit/permissions-sqlite`.
 */

/**
 * The minimal Prisma delegate surface the store calls — a real `PrismaClient`
 * with these models is assignable, so pass it directly. Method arguments are
 * typed `any` (Prisma's generated method generics can't be reproduced by a
 * hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaPermissionsClient {
  permUserRole: {
    findMany(a: any): Promise<{ role: string }[]>
    createMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
  permUserPermission: {
    findMany(a: any): Promise<{ permission: string }[]>
    createMany(a: any): Promise<{ count: number }>
  }
  permRolePermission: {
    findMany(a: any): Promise<{ permission: string }[]>
    createMany(a: any): Promise<{ count: number }>
  }
  /**
   * Optional: only {@link PrismaTemporaryGrantStore} needs it, so a client
   * generated before the model existed still types as a
   * `PrismaPermissionsClient`.
   */
  permTemporaryGrant?: {
    findMany(a: any): Promise<PermTemporaryGrantRow[]>
    upsert(a: any): Promise<unknown>
    deleteMany(a: any): Promise<{ count: number }>
  }
  /** Optional: only {@link PrismaDelegationStore} needs it. */
  permDelegation?: {
    findMany(a: any): Promise<PermDelegationRow[]>
    upsert(a: any): Promise<unknown>
    deleteMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A `PermTemporaryGrant` row. `permissions` is `String[]` on PostgreSQL, a `Json` array on MySQL. */
export interface PermTemporaryGrantRow {
  id: string
  scope: string
  userId: string
  permissions: unknown
  expiresAt: Date
  grantedBy: string | null
  reason: string | null
}

/** A `PermDelegation` row. `expiresAt` is `null` for an open-ended delegation. */
export interface PermDelegationRow {
  id: string
  scope: string
  fromUserId: string
  toUserId: string
  permissions: unknown
  createdAt: Date
  expiresAt: Date | null
}

/**
 * Direct writes validate what they persist: an empty or non-string user id,
 * role name or scope is refused with a `TypeError` instead of being written.
 * `''`, `null` and `undefined` would otherwise collapse into one shared
 * "nobody" key whose grants are honoured for every caller with a missing id.
 * (The Gate validates too; these guards cover code that writes to the store
 * directly — seed scripts, admin tools, migrations.)
 */
function assertKey(value: unknown, what: string, operation: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${operation}: ${what} must be a non-empty string`)
  }
}

function assertPermissionList(value: unknown, operation: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.length > 0)) {
    throw new TypeError(`${operation}: permissions must be an array of non-empty strings`)
  }
}

export type PermissionsColumnLimits = ColumnLimits<{
  PermUserRole: 'scope' | 'userId' | 'role'
  PermUserPermission: 'scope' | 'userId' | 'permission'
  PermRolePermission: 'scope' | 'role' | 'permission'
  PermTemporaryGrant: 'id' | 'scope' | 'userId' | 'grantedBy' | 'reason'
  PermDelegation: 'id' | 'scope' | 'fromUserId' | 'toUserId'
}>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Key and indexed columns stay VARCHAR(191); the free-text
 * `reason` of a temporary grant is `TEXT`. Spread it to override one column
 * after widening it.
 */
export const permissionsMysqlColumnLimits: PermissionsColumnLimits = {
  PermUserRole: { scope: V, userId: V, role: V },
  PermUserPermission: { scope: V, userId: V, permission: V },
  PermRolePermission: { scope: V, role: V, permission: V },
  PermTemporaryGrant: { id: V, scope: V, userId: V, grantedBy: V, reason: MYSQL_TEXT },
  PermDelegation: { id: V, scope: V, fromUserId: V, toUserId: V },
}

export interface PrismaAccessStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode two
   * long permission names cut to the same prefix collapse into one grant.
   * `'mysql'` uses the limits of the bundled `schema.mysql.prisma`; pass an
   * object for a schema of your own. Default: unchecked (PostgreSQL and
   * SQLite store any length).
   */
  columnLimits?: 'mysql' | PermissionsColumnLimits
}

export class PrismaAccessStore implements AccessStore {
  private readonly limits: PermissionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaPermissionsClient,
    options: PrismaAccessStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, permissionsMysqlColumnLimits)
  }

  async getUserRoles(userId: string, scope: string): Promise<string[]> {
    const rows = await this.client.permUserRole.findMany({ where: { scope, userId } })
    return rows.map((r) => r.role)
  }

  async getUserPermissions(userId: string, scope: string): Promise<string[]> {
    const rows = await this.client.permUserPermission.findMany({ where: { scope, userId } })
    return rows.map((r) => r.permission)
  }

  async getRolePermissions(role: string, scope: string): Promise<string[]> {
    const rows = await this.client.permRolePermission.findMany({ where: { scope, role } })
    return rows.map((r) => r.permission)
  }

  async assignRole(userId: string, role: string, scope: string): Promise<void> {
    assertKey(userId, 'userId', 'assignRole')
    assertKey(role, 'role', 'assignRole')
    assertKey(scope, 'scope', 'assignRole')
    assertColumnLengths(PKG, this.limits, 'PermUserRole', { scope, userId, role })
    await this.client.permUserRole.createMany({ data: [{ scope, userId, role }], skipDuplicates: true })
  }

  async removeRole(userId: string, role: string, scope: string): Promise<void> {
    assertKey(userId, 'userId', 'removeRole')
    assertKey(role, 'role', 'removeRole')
    assertKey(scope, 'scope', 'removeRole')
    await this.client.permUserRole.deleteMany({ where: { scope, userId, role } })
  }

  async grantToRole(role: string, permissions: string[], scope: string): Promise<void> {
    assertKey(role, 'role', 'grantToRole')
    assertPermissionList(permissions, 'grantToRole')
    assertKey(scope, 'scope', 'grantToRole')
    // Every row is checked before the batch is written, so a refused grant writes none of it.
    for (const permission of permissions) {
      assertColumnLengths(PKG, this.limits, 'PermRolePermission', { scope, role, permission })
    }
    await this.client.permRolePermission.createMany({
      data: permissions.map((permission) => ({ scope, role, permission })),
      skipDuplicates: true,
    })
  }

  async grantToUser(userId: string, permissions: string[], scope: string): Promise<void> {
    assertKey(userId, 'userId', 'grantToUser')
    assertPermissionList(permissions, 'grantToUser')
    assertKey(scope, 'scope', 'grantToUser')
    for (const permission of permissions) {
      assertColumnLengths(PKG, this.limits, 'PermUserPermission', { scope, userId, permission })
    }
    await this.client.permUserPermission.createMany({
      data: permissions.map((permission) => ({ scope, userId, permission })),
      skipDuplicates: true,
    })
  }
}

// --- temporary grants & delegations ----------------------------------------

/**
 * A string-list column: `String[]` on PostgreSQL, a `Json` array on MySQL
 * (`schema.mysql.prisma` — MySQL has no scalar lists). Anything else reads as empty.
 */
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** An epoch-ms instant a `DateTime` column can hold (`new Date(n)` is valid). */
function assertInstant(value: unknown, what: string, operation: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError(`${operation}: ${what} must be a finite epoch-ms timestamp`)
  }
}

function assertOptionalText(value: unknown, what: string, operation: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${operation}: ${what} must be a string when set`)
  }
}

function missingModel(delegate: string): Error {
  return new Error(
    `${PKG}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
      `schema.prisma (run \`basalt prisma:sync\`, or copy from '${PKG}/schema.prisma'), then \`prisma generate\`.`,
  )
}

/**
 * Durable `TemporaryGrantStore` (`PermTemporaryGrant` model): time-boxed grants
 * that survive a restart and are shared by every instance.
 *
 * `activeFor` filters `expiresAt > now`, user and scope in the query; the Gate
 * re-verifies all three on every row anyway, so a stale row can never become a
 * standing grant. Expired rows are inert — `pruneExpired()` deletes them.
 */
export class PrismaTemporaryGrantStore implements TemporaryGrantStore {
  private readonly limits: PermissionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaPermissionsClient,
    options: PrismaAccessStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, permissionsMysqlColumnLimits)
  }

  // Read per call, not in the constructor: a lazy client (database-per-tenant)
  // only resolves its models inside a request.
  private get model(): NonNullable<PrismaPermissionsClient['permTemporaryGrant']> {
    const model = this.client.permTemporaryGrant
    if (model == null) throw missingModel('permTemporaryGrant')
    return model
  }

  async add(grant: TemporaryGrant): Promise<void> {
    assertKey(grant?.id, 'id', 'TemporaryGrantStore.add')
    assertKey(grant.userId, 'userId', 'TemporaryGrantStore.add')
    assertKey(grant.scope, 'scope', 'TemporaryGrantStore.add')
    assertPermissionList(grant.permissions, 'TemporaryGrantStore.add')
    assertInstant(grant.expiresAt, 'expiresAt', 'TemporaryGrantStore.add')
    assertOptionalText(grant.grantedBy, 'grantedBy', 'TemporaryGrantStore.add')
    assertOptionalText(grant.reason, 'reason', 'TemporaryGrantStore.add')
    const data = {
      id: grant.id,
      scope: grant.scope,
      userId: grant.userId,
      permissions: [...grant.permissions],
      expiresAt: new Date(grant.expiresAt),
      grantedBy: grant.grantedBy ?? null,
      reason: grant.reason ?? null,
    }
    assertColumnLengths(PKG, this.limits, 'PermTemporaryGrant', data)
    // Same id replaces, like the in-memory store.
    await this.model.upsert({ where: { id: grant.id }, create: data, update: data })
  }

  async activeFor(userId: string, scope: string, now: number): Promise<TemporaryGrant[]> {
    const rows = await this.model.findMany({ where: { scope, userId, expiresAt: { gt: new Date(now) } } })
    return rows.map(toTemporaryGrant)
  }

  async revoke(id: string): Promise<void> {
    assertKey(id, 'id', 'TemporaryGrantStore.revoke')
    await this.model.deleteMany({ where: { id } })
  }

  async all(): Promise<TemporaryGrant[]> {
    return (await this.model.findMany({})).map(toTemporaryGrant)
  }

  /** Deletes grants expired at `now` (default: the current time). Returns how many. */
  async pruneExpired(now: number = Date.now()): Promise<number> {
    const { count } = await this.model.deleteMany({ where: { expiresAt: { lte: new Date(now) } } })
    return count
  }
}

function toTemporaryGrant(row: PermTemporaryGrantRow): TemporaryGrant {
  return {
    id: row.id,
    userId: row.userId,
    permissions: stringList(row.permissions),
    scope: row.scope,
    expiresAt: row.expiresAt.getTime(),
    ...(row.grantedBy !== null ? { grantedBy: row.grantedBy } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
  }
}

/**
 * Durable `DelegationStore` (`PermDelegation` model). `activeTo`/`activeFrom`
 * return open-ended delegations (`expiresAt` NULL) and those with
 * `expiresAt > now`, in the given scope only; the Gate re-verifies each row.
 */
export class PrismaDelegationStore implements DelegationStore {
  private readonly limits: PermissionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaPermissionsClient,
    options: PrismaAccessStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, permissionsMysqlColumnLimits)
  }

  private get model(): NonNullable<PrismaPermissionsClient['permDelegation']> {
    const model = this.client.permDelegation
    if (model == null) throw missingModel('permDelegation')
    return model
  }

  async add(delegation: Delegation): Promise<void> {
    assertKey(delegation?.id, 'id', 'DelegationStore.add')
    assertKey(delegation.fromUserId, 'fromUserId', 'DelegationStore.add')
    assertKey(delegation.toUserId, 'toUserId', 'DelegationStore.add')
    assertKey(delegation.scope, 'scope', 'DelegationStore.add')
    assertPermissionList(delegation.permissions, 'DelegationStore.add')
    assertInstant(delegation.createdAt, 'createdAt', 'DelegationStore.add')
    if (delegation.expiresAt !== undefined) assertInstant(delegation.expiresAt, 'expiresAt', 'DelegationStore.add')
    const data = {
      id: delegation.id,
      scope: delegation.scope,
      fromUserId: delegation.fromUserId,
      toUserId: delegation.toUserId,
      permissions: [...delegation.permissions],
      createdAt: new Date(delegation.createdAt),
      expiresAt: delegation.expiresAt !== undefined ? new Date(delegation.expiresAt) : null,
    }
    assertColumnLengths(PKG, this.limits, 'PermDelegation', data)
    await this.model.upsert({ where: { id: delegation.id }, create: data, update: data })
  }

  async activeTo(toUserId: string, scope: string, now: number): Promise<Delegation[]> {
    const rows = await this.model.findMany({ where: { scope, toUserId, ...live(now) } })
    return rows.map(toDelegation)
  }

  async activeFrom(fromUserId: string, scope: string, now: number): Promise<Delegation[]> {
    const rows = await this.model.findMany({ where: { scope, fromUserId, ...live(now) } })
    return rows.map(toDelegation)
  }

  async revoke(id: string): Promise<void> {
    assertKey(id, 'id', 'DelegationStore.revoke')
    await this.model.deleteMany({ where: { id } })
  }

  async all(): Promise<Delegation[]> {
    return (await this.model.findMany({})).map(toDelegation)
  }

  /** Deletes delegations whose deadline passed at `now`; open-ended ones stay. Returns how many. */
  async pruneExpired(now: number = Date.now()): Promise<number> {
    const { count } = await this.model.deleteMany({ where: { expiresAt: { lte: new Date(now) } } })
    return count
  }
}

const live = (now: number) => ({ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }] })

function toDelegation(row: PermDelegationRow): Delegation {
  return {
    id: row.id,
    fromUserId: row.fromUserId,
    toUserId: row.toUserId,
    permissions: stringList(row.permissions),
    scope: row.scope,
    createdAt: row.createdAt.getTime(),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt.getTime() } : {}),
  }
}

export interface PrismaPermissionsStores {
  store: PrismaAccessStore
  /**
   * Durable time-boxed grants — pass as `permissionsPlugin({ temporaryGrants })`
   * once the `PermTemporaryGrant` model is migrated (used only when wired).
   */
  temporaryGrants: PrismaTemporaryGrantStore
  /** Durable delegations — pass as `permissionsPlugin({ delegations })` once `PermDelegation` is migrated. */
  delegations: PrismaDelegationStore
}

/**
 * Wire the access store to your Prisma client, named to drop straight into
 * `permissionsPlugin`:
 *
 * ```ts
 * const p = prismaAccessStore(prisma) // on MySQL: prismaAccessStore(prisma, { columnLimits: 'mysql' })
 * permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
 * ```
 *
 * `temporaryGrants`/`delegations` need the `PermTemporaryGrant`/`PermDelegation`
 * models; they are checked when first used, so an app that does not wire them
 * needs neither model.
 */
// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'create' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaAccessStore(
  client: PrismaPermissionsClient,
  options: PrismaAccessStoreOptions = {},
): PrismaPermissionsStores {
  ensureModel(client, 'permUserRole', PKG)
  return {
    store: new PrismaAccessStore(client, options),
    temporaryGrants: new PrismaTemporaryGrantStore(client, options),
    delegations: new PrismaDelegationStore(client, options),
  }
}
