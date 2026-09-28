import type { AccessStore } from '@basaltkit/permissions'
import { assertColumnLengths, type ColumnLimits, MYSQL_VARCHAR_DEFAULT as V, resolveColumnLimits } from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/permissions-prisma'

/**
 * Prisma-backed implementation of the `@basaltkit/permissions` `AccessStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `PermUserRole`, `PermUserPermission` and
 * `PermRolePermission` models (see the bundled `prisma/schema.prisma`).
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
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
}>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Every column is part of a composite primary key, so all
 * stay VARCHAR(191). Spread it to override one column after widening it.
 */
export const permissionsMysqlColumnLimits: PermissionsColumnLimits = {
  PermUserRole: { scope: V, userId: V, role: V },
  PermUserPermission: { scope: V, userId: V, permission: V },
  PermRolePermission: { scope: V, role: V, permission: V },
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

export interface PrismaPermissionsStores {
  store: PrismaAccessStore
}

/**
 * Wire the access store to your Prisma client, named to drop straight into
 * `permissionsPlugin`:
 *
 * ```ts
 * const p = prismaAccessStore(prisma) // on MySQL: prismaAccessStore(prisma, { columnLimits: 'mysql' })
 * permissionsPlugin({ store: p.store })
 * ```
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
  return { store: new PrismaAccessStore(client, options) }
}
