import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type {
  ApiKeyFilter,
  ApiKeyRecord,
  ApiKeyStore,
  AuthTokenPurpose,
  AuthTokenRecord,
  AuthTokenStore,
  AuthUser,
  MfaRecord,
  MfaStore,
  PublicUser,
  RefreshRecord,
  RefreshTokenStore,
  SessionRecord,
  SessionStore,
  TokenVersionStore,
  UserPatch,
  UserSource,
} from '@basaltkit/auth'

/**
 * Prisma-backed implementations of every `@basaltkit/auth` store — the reference
 * "real backend" for production (PostgreSQL, MySQL, …). Bring your own generated
 * `PrismaClient` whose schema includes the `Auth*` models (see the bundled
 * `prisma/schema.prisma`); the stores only touch those delegates, so they layer
 * onto an existing client without owning it.
 *
 * Pairs with `@basaltkit/auth-sqlite` (the zero-dependency, single-node option):
 * same store contracts, different backend.
 */

// --- the client surface these stores need — satisfied by a PrismaClient -----

/**
 * The non-credential columns of a user row — all a directory lookup
 * (`findByIds`) selects, so the password hash never leaves the database.
 */
interface PUserContact {
  id: string
  email: string
  emailVerified: boolean
}
/** A row as Prisma returns it (DateTime → Date, Boolean → boolean). */
interface PUser extends PUserContact {
  passwordHash: string
}
interface PSession {
  id: string
  userId: string
  expiresAt: Date
}
interface PRefresh {
  token: string
  familyId: string
  userId: string
  expiresAt: Date
  usedAt: Date | null
}
interface PAuthToken {
  token: string
  userId: string
  purpose: string
  expiresAt: Date
  usedAt: Date | null
}
interface PApiKey {
  id: string
  name: string
  prefix: string
  hash: string
  tenantId: string | null
  userId: string | null
  scopes: string[]
  createdAt: Date
  expiresAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
}
interface PMfa {
  userId: string
  secret: string
  enabled: boolean
  recoveryCodes: string[]
  lastUsedStep: number | null
}

/**
 * The minimal Prisma delegate surface the stores call. A real `PrismaClient`
 * whose schema has these `Auth*` models is assignable to this, so you pass your
 * client directly: `prismaAuthStores(prisma)`.
 *
 * Method **arguments** are typed `any` on purpose: Prisma generates each
 * delegate method as a generic (`findUnique<T>(args: SelectSubset<T, …>)`) whose
 * exact `where`/`data`/`select` shapes a hand-written interface can't reproduce
 * without importing your generated client — so a precise arg type makes a real
 * client *non-assignable*. The **return** types stay precise (the rows the
 * stores read back and convert), which is the half that matters for safety.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaAuthClient {
  authUser: {
    findUnique(a: any): Promise<PUser | null>
    findFirst(a: any): Promise<PUser | null>
    // Only ever called with a `select` of the non-credential columns, so the
    // return type is narrowed to those (a full row is assignable to it).
    findMany(a: any): Promise<PUserContact[]>
    create(a: any): Promise<PUser>
    update(a: any): Promise<PUser>
  }
  authSession: {
    findUnique(a: any): Promise<PSession | null>
    create(a: any): Promise<PSession>
    deleteMany(a: any): Promise<{ count: number }>
  }
  authRefreshToken: {
    findUnique(a: any): Promise<PRefresh | null>
    create(a: any): Promise<PRefresh>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
  authToken: {
    findUnique(a: any): Promise<PAuthToken | null>
    create(a: any): Promise<PAuthToken>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
  authApiKey: {
    findUnique(a: any): Promise<PApiKey | null>
    findMany(a: any): Promise<PApiKey[]>
    create(a: any): Promise<PApiKey>
    update(a: any): Promise<PApiKey>
  }
  authMfa: {
    findUnique(a: any): Promise<PMfa | null>
    updateMany(a: any): Promise<{ count: number }>
    upsert(a: any): Promise<PMfa>
    deleteMany(a: any): Promise<{ count: number }>
  }
  authTokenVersion: {
    findUnique(a: any): Promise<{ userId: string; version: number } | null>
    upsert(a: any): Promise<{ userId: string; version: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- boundary helpers -------------------------------------------------------

// The @basaltkit/auth contracts model time as epoch-ms numbers; Prisma models it
// as DateTime (Date). Convert at the edges, and map nullable columns to the
// optional-property shape the contracts use.
const ms = (d: Date): number => d.getTime()
const at = (n: number): Date => new Date(n)
/** SHA-256 of a session id — only this is persisted, never the raw cookie value. */
const hashSessionId = (id: string): string => createHash('sha256').update(id).digest('hex')

// --- users ------------------------------------------------------------------

const toUser = (r: PUser): AuthUser => ({
  id: r.id,
  email: r.email,
  passwordHash: r.passwordHash,
  emailVerified: r.emailVerified,
})

/** Escapes LIKE/ILIKE metacharacters (backslash, `%`, `_`) with the default backslash escape. */
const escapeLikePattern = (value: string): string => value.replace(/[\\%_]/g, '\\$&')

/**
 * How many ids go into one `WHERE id IN (…)` of {@link PrismaUserSource.findByIds}.
 * 500 sits far below PostgreSQL's 65 535 bind parameters and well inside
 * MySQL's `max_allowed_packet`, so even a ten-thousand-member tenant resolves
 * without the driver refusing the statement.
 */
const DEFAULT_ID_CHUNK_SIZE = 500

export interface PrismaUserSourceOptions {
  /** Ids per `IN (…)` query in `findByIds`. Default {@link DEFAULT_ID_CHUNK_SIZE}. */
  idChunkSize?: number
}

export class PrismaUserSource implements UserSource {
  private readonly idChunkSize: number

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaUserSourceOptions = {},
  ) {
    this.idChunkSize = Math.max(1, Math.trunc(options.idChunkSize ?? DEFAULT_ID_CHUNK_SIZE))
  }

  /**
   * Emails are case-insensitive identities: new rows are stored canonical
   * (trimmed, lowercased) and looked up that way; a row written before that, in
   * mixed case, is still found through a case-insensitive fallback query.
   */
  async findByEmail(email: string): Promise<AuthUser | null> {
    const canonical = email.trim().toLowerCase()
    const r = await this.client.authUser.findUnique({ where: { email: canonical } })
    if (r) return toUser(r)
    try {
      // On PostgreSQL Prisma compiles an insensitive `equals` to `email ILIKE $1`
      // WITHOUT escaping the value, so `_` and `%` (both legal in an address)
      // would be wildcards and `a_min@corp.test` would resolve to
      // `admin@corp.test` (account takeover through social login, a fresh
      // login-throttle budget per pattern). Escape them, and re-check the match
      // in code so no provider's pattern semantics can return another account.
      const legacy = await this.client.authUser.findFirst({
        where: { email: { equals: escapeLikePattern(canonical), mode: 'insensitive' } },
        orderBy: { id: 'asc' },
      })
      return legacy && legacy.email.trim().toLowerCase() === canonical ? toUser(legacy) : null
    } catch (err) {
      // `mode: 'insensitive'` is PostgreSQL/MongoDB-only; providers without it
      // (MySQL, SQLite) already compare with a case-insensitive collation or
      // hold only canonical rows, so the exact lookup above is authoritative.
      if ((err as { name?: unknown } | null)?.name === 'PrismaClientValidationError') return null
      throw err
    }
  }

  async findById(id: string): Promise<AuthUser | null> {
    const r = await this.client.authUser.findUnique({ where: { id } })
    return r ? toUser(r) : null
  }

  /**
   * One `WHERE id IN (…)` per chunk instead of one query per id. `select`
   * lists only the non-credential columns, so the password hash is never even
   * read; ids with no row are simply absent from the result, which stays in
   * the order the caller asked for.
   */
  async findByIds(ids: readonly string[]): Promise<PublicUser[]> {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const found = new Map<string, PublicUser>()
    for (let i = 0; i < unique.length; i += this.idChunkSize) {
      const rows = await this.client.authUser.findMany({
        where: { id: { in: unique.slice(i, i + this.idChunkSize) } },
        select: { id: true, email: true, emailVerified: true },
      })
      for (const r of rows) found.set(r.id, { id: r.id, email: r.email, emailVerified: r.emailVerified })
    }
    return unique.flatMap((id) => {
      const user = found.get(id)
      return user ? [user] : []
    })
  }

  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> {
    const r = await this.client.authUser.create({
      data: { id: randomUUID(), email: data.email.trim().toLowerCase(), passwordHash: data.passwordHash, emailVerified: false },
    })
    return toUser(r)
  }

  async update(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const data: Partial<PUser> = {}
    if (patch.passwordHash !== undefined) data.passwordHash = patch.passwordHash
    if (patch.emailVerified !== undefined) data.emailVerified = patch.emailVerified
    if (Object.keys(data).length === 0) return this.findById(id)
    const r = await this.client.authUser.update({ where: { id }, data })
    return toUser(r)
  }
}

// --- one-time tokens --------------------------------------------------------

const toAuthToken = (r: PAuthToken): AuthTokenRecord => {
  const rec: AuthTokenRecord = {
    token: r.token,
    userId: r.userId,
    purpose: r.purpose as AuthTokenPurpose,
    expiresAt: ms(r.expiresAt),
  }
  if (r.usedAt !== null) rec.usedAt = ms(r.usedAt)
  return rec
}

export class PrismaAuthTokenStore implements AuthTokenStore {
  constructor(private readonly client: PrismaAuthClient) {}

  async create(record: AuthTokenRecord): Promise<void> {
    await this.client.authToken.create({
      data: {
        token: record.token,
        userId: record.userId,
        purpose: record.purpose,
        expiresAt: at(record.expiresAt),
        usedAt: record.usedAt !== undefined ? at(record.usedAt) : null,
      },
    })
  }

  async find(token: string): Promise<AuthTokenRecord | null> {
    const r = await this.client.authToken.findUnique({ where: { token } })
    return r ? toAuthToken(r) : null
  }

  async markUsed(token: string): Promise<boolean> {
    // Conditional update = compare-and-swap. `count === 0` means it was already
    // consumed, so the caller must reject instead of trusting its earlier read.
    const { count } = await this.client.authToken.updateMany({
      where: { token, usedAt: null },
      data: { usedAt: new Date() },
    })
    return count > 0
  }

  async deleteForUser(userId: string, purpose: AuthTokenPurpose): Promise<void> {
    await this.client.authToken.deleteMany({ where: { userId, purpose } })
  }
}

// --- sessions ---------------------------------------------------------------

export class PrismaSessionStore implements SessionStore {
  constructor(private readonly client: PrismaAuthClient) {}

  async create(userId: string, ttlMs: number): Promise<SessionRecord> {
    // Mint a raw id for the client (cookie), but store its hash so a dump of the
    // session table can't be replayed as a live session.
    const rawId = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + ttlMs
    await this.client.authSession.create({
      data: { id: hashSessionId(rawId), userId, expiresAt: at(expiresAt) },
    })
    return { id: rawId, userId, expiresAt }
  }

  async find(id: string): Promise<SessionRecord | null> {
    const hashed = hashSessionId(id)
    const r = await this.client.authSession.findUnique({ where: { id: hashed } })
    if (!r) return null
    const expiresAt = ms(r.expiresAt)
    if (Date.now() >= expiresAt) {
      await this.client.authSession.deleteMany({ where: { id: hashed } })
      return null
    }
    // Echo the id the caller queried with (never the stored hash).
    return { id, userId: r.userId, expiresAt }
  }

  async delete(id: string): Promise<boolean> {
    const { count } = await this.client.authSession.deleteMany({ where: { id: hashSessionId(id) } })
    return count > 0
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.client.authSession.deleteMany({ where: { userId } })
  }
}

// --- refresh tokens ---------------------------------------------------------

const toRefresh = (r: PRefresh): RefreshRecord => {
  const rec: RefreshRecord = {
    token: r.token,
    familyId: r.familyId,
    userId: r.userId,
    expiresAt: ms(r.expiresAt),
  }
  if (r.usedAt !== null) rec.usedAt = ms(r.usedAt)
  return rec
}

export class PrismaRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly client: PrismaAuthClient) {}

  async create(record: RefreshRecord): Promise<void> {
    await this.client.authRefreshToken.create({
      data: {
        token: record.token,
        familyId: record.familyId,
        userId: record.userId,
        expiresAt: at(record.expiresAt),
        usedAt: record.usedAt !== undefined ? at(record.usedAt) : null,
      },
    })
  }

  async find(token: string): Promise<RefreshRecord | null> {
    const r = await this.client.authRefreshToken.findUnique({ where: { token } })
    return r ? toRefresh(r) : null
  }

  async markUsed(token: string): Promise<boolean> {
    // Conditional update = compare-and-swap; `count === 0` is a reuse signal.
    const { count } = await this.client.authRefreshToken.updateMany({
      where: { token, usedAt: null },
      data: { usedAt: new Date() },
    })
    return count > 0
  }

  async revokeFamily(familyId: string): Promise<void> {
    await this.client.authRefreshToken.deleteMany({ where: { familyId } })
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.client.authRefreshToken.deleteMany({ where: { userId } })
  }
}

// --- API keys ---------------------------------------------------------------

const toApiKey = (r: PApiKey): ApiKeyRecord => {
  const rec: ApiKeyRecord = {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    hash: r.hash,
    scopes: r.scopes,
    createdAt: ms(r.createdAt),
  }
  if (r.expiresAt !== null) rec.expiresAt = ms(r.expiresAt)
  if (r.tenantId !== null) rec.tenantId = r.tenantId
  if (r.userId !== null) rec.userId = r.userId
  if (r.lastUsedAt !== null) rec.lastUsedAt = ms(r.lastUsedAt)
  if (r.revokedAt !== null) rec.revokedAt = ms(r.revokedAt)
  return rec
}

/**
 * The database's `auth_api_keys` table is older than the store: a column the
 * store reads or writes does not exist. `@basaltkit/auth-prisma` 1.5.0 added
 * `expiresAt`; an app that regenerated its client without migrating (or, with
 * schema-per-tenant, without migrating every tenant schema) would otherwise fail
 * every API-key request with a raw Prisma `P2022`. The original error is `cause`.
 */
export class ApiKeySchemaOutdatedError extends BasaltError {
  constructor(cause: unknown) {
    super(
      'AUTH_API_KEY_SCHEMA_OUTDATED',
      'The "auth_api_keys" table is missing a column the API key store needs. ' +
        '@basaltkit/auth-prisma 1.5.0 added the nullable column "auth_api_keys.expiresAt"; ' +
        'add a migration for it (e.g. `prisma migrate dev --name add_api_key_expires_at`), which on PostgreSQL is: ' +
        'ALTER TABLE "auth_api_keys" ADD COLUMN "expiresAt" TIMESTAMP(3); ' +
        'With schema-per-tenant the column must exist in EVERY tenant schema: add the migration to your ' +
        'tenant migrations, then run `basalt tenant:migrate`.',
      { cause },
    )
  }
}

// "Undefined column" codes: Prisma P2022, PostgreSQL 42703, MySQL 1054.
const UNDEFINED_COLUMN_CODES = new Set<unknown>(['P2022', '42703', 1054, '1054', 'ER_BAD_FIELD_ERROR'])
const MISSING_COLUMN_TEXT = /does not exist|no such column|unknown column|ColumnNotFound/i

/**
 * Whether `err` reports a missing `auth_api_keys` column. Every query here goes
 * through the `authApiKey` delegate, so an undefined-column code can only mean
 * that table is outdated. A driver-adapter error without a recognised code must
 * name `expiresAt` in its message or meta, so unrelated failures are never
 * relabelled. Nested `cause`s are followed a few levels deep.
 */
function isApiKeySchemaOutdated(err: unknown, depth = 0): boolean {
  if (typeof err !== 'object' || err === null || depth > 3) return false
  const e = err as {
    code?: unknown
    originalCode?: unknown
    kind?: unknown
    message?: unknown
    meta?: unknown
    cause?: unknown
  }
  if (UNDEFINED_COLUMN_CODES.has(e.code) || UNDEFINED_COLUMN_CODES.has(e.originalCode)) return true
  let meta = ''
  try {
    meta = e.meta === undefined ? '' : JSON.stringify(e.meta)
  } catch {
    // unserializable meta: judge by the message alone
  }
  const text = [e.message, e.kind].filter((v) => typeof v === 'string').join(' ') + ' ' + meta
  if (text.includes('expiresAt') && MISSING_COLUMN_TEXT.test(text)) return true
  return isApiKeySchemaOutdated(e.cause, depth + 1)
}

/** A missing-column failure becomes an actionable error; anything else is returned untouched. */
const apiKeyError = (err: unknown): unknown =>
  isApiKeySchemaOutdated(err) ? new ApiKeySchemaOutdatedError(err) : err

export class PrismaApiKeyStore implements ApiKeyStore {
  constructor(private readonly client: PrismaAuthClient) {}

  // Each query is wrapped so an un-migrated database surfaces as
  // AUTH_API_KEY_SCHEMA_OUTDATED instead of a raw "column does not exist".

  async create(record: ApiKeyRecord): Promise<void> {
    try {
      await this.client.authApiKey.create({
        data: {
          id: record.id,
          name: record.name,
          prefix: record.prefix,
          hash: record.hash,
          tenantId: record.tenantId ?? null,
          userId: record.userId ?? null,
          scopes: record.scopes,
          createdAt: at(record.createdAt),
          expiresAt: record.expiresAt !== undefined ? at(record.expiresAt) : null,
          lastUsedAt: record.lastUsedAt !== undefined ? at(record.lastUsedAt) : null,
          revokedAt: record.revokedAt !== undefined ? at(record.revokedAt) : null,
        },
      })
    } catch (err) {
      throw apiKeyError(err)
    }
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    try {
      const r = await this.client.authApiKey.findUnique({ where: { hash } })
      return r ? toApiKey(r) : null
    } catch (err) {
      throw apiKeyError(err)
    }
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    try {
      const r = await this.client.authApiKey.findUnique({ where: { id } })
      return r ? toApiKey(r) : null
    } catch (err) {
      throw apiKeyError(err)
    }
  }

  async list(filter: ApiKeyFilter): Promise<ApiKeyRecord[]> {
    const where: { revokedAt: null; tenantId?: string; userId?: string } = { revokedAt: null }
    if (filter.tenantId !== undefined) where.tenantId = filter.tenantId
    if (filter.userId !== undefined) where.userId = filter.userId
    try {
      const rows = await this.client.authApiKey.findMany({ where, orderBy: { createdAt: 'asc' } })
      return rows.map(toApiKey)
    } catch (err) {
      throw apiKeyError(err)
    }
  }

  async touch(id: string, at_: number): Promise<void> {
    try {
      await this.client.authApiKey.update({ where: { id }, data: { lastUsedAt: at(at_) } })
    } catch (err) {
      throw apiKeyError(err)
    }
  }

  async revoke(id: string, at_: number): Promise<void> {
    try {
      await this.client.authApiKey.update({ where: { id }, data: { revokedAt: at(at_) } })
    } catch (err) {
      throw apiKeyError(err)
    }
  }
}

// --- MFA --------------------------------------------------------------------

export class PrismaMfaStore implements MfaStore {
  constructor(private readonly client: PrismaAuthClient) {}

  async get(userId: string): Promise<MfaRecord | null> {
    const r = await this.client.authMfa.findUnique({ where: { userId } })
    if (!r) return null
    return {
      secret: r.secret,
      enabled: r.enabled,
      recoveryCodes: r.recoveryCodes,
      ...(r.lastUsedStep !== null ? { lastUsedStep: r.lastUsedStep } : {}),
    }
  }

  async set(userId: string, record: MfaRecord): Promise<void> {
    const data = {
      secret: record.secret,
      enabled: record.enabled,
      recoveryCodes: record.recoveryCodes,
      lastUsedStep: record.lastUsedStep ?? null,
    }
    await this.client.authMfa.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    })
  }

  async delete(userId: string): Promise<void> {
    await this.client.authMfa.deleteMany({ where: { userId } })
  }

  /** Conditional UPDATE: only one caller can move the TOTP step forward. */
  async consumeTotpStep(userId: string, step: number): Promise<boolean> {
    const { count } = await this.client.authMfa.updateMany({
      where: { userId, enabled: true, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }] },
      data: { lastUsedStep: step },
    })
    return count > 0
  }

  /** Compare-and-swap on the stored list: a concurrent consumer makes this one fail. */
  async consumeRecoveryCode(userId: string, hash: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this.client.authMfa.findUnique({ where: { userId } })
      if (!r || !r.enabled) return false
      const index = r.recoveryCodes.indexOf(hash)
      if (index === -1) return false
      const next = r.recoveryCodes.filter((_, i) => i !== index)
      const { count } = await this.client.authMfa.updateMany({
        where: { userId, recoveryCodes: { equals: r.recoveryCodes } },
        data: { recoveryCodes: next },
      })
      if (count > 0) return true
    }
    return false
  }
}

export class PrismaTokenVersionStore implements TokenVersionStore {
  constructor(private readonly client: PrismaAuthClient) {}

  async get(userId: string): Promise<number> {
    return (await this.client.authTokenVersion.findUnique({ where: { userId } }))?.version ?? 0
  }

  async increment(userId: string): Promise<number> {
    const r = await this.client.authTokenVersion.upsert({
      where: { userId },
      create: { userId, version: 1 },
      update: { version: { increment: 1 } },
    })
    return r.version
  }
}

// --- convenience ------------------------------------------------------------

export interface PrismaAuthStores {
  users: PrismaUserSource
  sessions: PrismaSessionStore
  refreshTokens: PrismaRefreshTokenStore
  tokens: PrismaAuthTokenStore
  apiKeys: PrismaApiKeyStore
  mfa: PrismaMfaStore
  tokenVersions: PrismaTokenVersionStore
}

/**
 * Wire every auth store to your Prisma client, named to drop straight into
 * `authPlugin` / `apiKeysPlugin`:
 *
 * ```ts
 * const s = prismaAuthStores(prisma)
 * authPlugin({ users: s.users, sessions: s.sessions, refreshTokens: s.refreshTokens,
 *              tokens: s.tokens, mfa: s.mfa, secret })
 * apiKeysPlugin({ store: s.apiKeys, users: s.users })
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

export function prismaAuthStores(client: PrismaAuthClient): PrismaAuthStores {
  ensureModel(client, 'authUser', '@basaltkit/auth-prisma')
  return {
    users: new PrismaUserSource(client),
    sessions: new PrismaSessionStore(client),
    refreshTokens: new PrismaRefreshTokenStore(client),
    tokens: new PrismaAuthTokenStore(client),
    apiKeys: new PrismaApiKeyStore(client),
    mfa: new PrismaMfaStore(client),
    tokenVersions: new PrismaTokenVersionStore(client),
  }
}
