import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import { AccountEmailAmbiguousError, EmailTakenError } from '@basaltkit/auth'
import type {
  AccountLink,
  AccountLinkStore,
  ApiKeyFilter,
  ApiKeyRecord,
  ApiKeyStore,
  AuthTokenPurpose,
  AuthTokenRecord,
  AuthTokenStore,
  AuthUser,
  MfaRecord,
  MfaStore,
  PasskeyCredential,
  PasskeyStore,
  PublicUser,
  RefreshRecord,
  RefreshTokenStore,
  SessionRecord,
  SessionStore,
  TokenVersionStore,
  UserPatch,
  UserSource,
} from '@basaltkit/auth'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/auth-prisma'

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
  /** Present once the schema has the column (see `trackSessionActivity`). */
  lastSeenAt?: Date | null
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
interface PAccountLink {
  id: string
  provider: string
  subject: string
  userId: string
  email: string
  createdAt: Date
}
interface PPasskey {
  id: string
  credentialId: string
  userId: string
  publicKey: string
  counter: bigint | number
  transports: string | null
  deviceName: string | null
  createdAt: Date
  lastUsedAt: Date | null
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
    // Typed as the non-credential columns (a full row is assignable to it):
    // directory lookups `select` only those; `findByEmail` reads full rows
    // (no `select`) and says so where it calls it.
    findMany(a: any): Promise<PUserContact[]>
    create(a: any): Promise<PUser>
    update(a: any): Promise<PUser>
  }
  authSession: {
    findUnique(a: any): Promise<PSession | null>
    create(a: any): Promise<PSession>
    /** Used only with `trackSessionActivity: true`. */
    updateMany?(a: any): Promise<{ count: number }>
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
    updateMany(a: any): Promise<{ count: number }>
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
  /**
   * `AuthAccountLink` (OAuth/OIDC provider subject → user). Optional so a client
   * generated before 2.0 still type-checks; {@link PrismaAccountLinkStore}
   * throws an actionable error at first use when it is missing.
   */
  authAccountLink?: {
    findUnique(a: any): Promise<PAccountLink | null>
    findMany(a: any): Promise<PAccountLink[]>
    create(a: any): Promise<PAccountLink>
    deleteMany(a: any): Promise<{ count: number }>
  }
  /** `AuthPasskey` (WebAuthn credentials). Optional, like {@link authAccountLink}. */
  authPasskey?: {
    findUnique(a: any): Promise<PPasskey | null>
    findMany(a: any): Promise<PPasskey[]>
    create(a: any): Promise<PPasskey>
    updateMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
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
/**
 * A string-list column: `String[]` on PostgreSQL, a `Json` array on MySQL
 * (`schema.mysql.prisma` — MySQL has no scalar lists). Anything else reads as empty.
 */
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

// --- column limits (MySQL) --------------------------------------------------

export type AuthColumnLimits = ColumnLimits<{
  AuthUser: 'id' | 'email' | 'passwordHash'
  AuthSession: 'id' | 'userId'
  AuthRefreshToken: 'token' | 'familyId' | 'userId'
  AuthToken: 'token' | 'userId' | 'purpose'
  AuthApiKey: 'id' | 'name' | 'prefix' | 'hash' | 'tenantId' | 'userId'
  AuthMfa: 'userId' | 'secret'
  AuthTokenVersion: 'userId'
  AuthAccountLink: 'id' | 'provider' | 'subject' | 'userId' | 'email'
  AuthPasskey: 'id' | 'credentialId' | 'userId' | 'publicKey' | 'transports' | 'deviceName'
}>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Keys and hashed tokens stay VARCHAR(191); a user's email
 * is VARCHAR(254), the longest valid address; password hashes, sealed TOTP
 * secrets, provider subjects, credential ids and public keys are TEXT.
 * Spread it to override one column after widening it.
 */
export const authMysqlColumnLimits: AuthColumnLimits = {
  AuthUser: { id: V, email: 254, passwordHash: MYSQL_TEXT },
  AuthSession: { id: V, userId: V },
  AuthRefreshToken: { token: V, familyId: V, userId: V },
  AuthToken: { token: V, userId: V, purpose: V },
  AuthApiKey: { id: V, name: MYSQL_TEXT, prefix: V, hash: V, tenantId: V, userId: V },
  AuthMfa: { userId: V, secret: MYSQL_TEXT },
  AuthTokenVersion: { userId: V },
  AuthAccountLink: { id: V, provider: V, subject: MYSQL_TEXT, userId: V, email: MYSQL_TEXT },
  AuthPasskey: {
    id: V,
    credentialId: MYSQL_TEXT,
    userId: V,
    publicKey: MYSQL_TEXT,
    transports: MYSQL_TEXT,
    deviceName: MYSQL_TEXT,
  },
}

/** Options every auth store (and {@link prismaAuthStores}) takes. */
export interface PrismaAuthStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode a cut
   * password hash never verifies and a cut sealed TOTP secret no longer opens.
   * `'mysql'` uses the limits of the bundled `schema.mysql.prisma`; pass an
   * object for a schema of your own. Default: unchecked (PostgreSQL and
   * SQLite store any length).
   */
  columnLimits?: 'mysql' | AuthColumnLimits
  /**
   * Record session activity in `AuthSession.lastSeenAt`, so `authPlugin`'s
   * `sessionIdleTtl` can be enforced. Needs the column (in the bundled
   * schemas since 2.1 — migrate before enabling). Off by default, so an app
   * that has not migrated keeps working unchanged.
   */
  trackSessionActivity?: boolean
}

const limitsOf = (options: PrismaAuthStoreOptions): AuthColumnLimits | undefined =>
  resolveColumnLimits(PKG, options.columnLimits, authMysqlColumnLimits)

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

export interface PrismaUserSourceOptions extends PrismaAuthStoreOptions {
  /** Ids per `IN (…)` query in `findByIds`. Default `DEFAULT_ID_CHUNK_SIZE` (500). */
  idChunkSize?: number
}

export class PrismaUserSource implements UserSource {
  private readonly idChunkSize: number
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaUserSourceOptions = {},
  ) {
    this.idChunkSize = Math.max(1, Math.trunc(options.idChunkSize ?? DEFAULT_ID_CHUNK_SIZE))
    this.limits = limitsOf(options)
  }

  /** Set once the provider rejects `mode: 'insensitive'` (MySQL, SQLite), so it is not retried per lookup. */
  private insensitiveUnsupported = false

  /**
   * Emails are case-insensitive identities: new rows are stored canonical
   * (trimmed, lowercased). Rows written before that may be mixed-case, so on
   * PostgreSQL the lookup is case-insensitive and **refuses ambiguity**: when
   * two rows differ only in letter case it throws
   * {@link AccountEmailAmbiguousError} instead of picking one (run
   * {@link normalizeAuthUserEmails} to find and fix them). On MySQL the column
   * collation is already case-insensitive and the unique index rules out
   * case-variant duplicates, so the exact lookup is authoritative.
   */
  async findByEmail(email: string): Promise<AuthUser | null> {
    const canonical = email.trim().toLowerCase()
    if (!this.insensitiveUnsupported) {
      try {
        // On PostgreSQL Prisma compiles an insensitive `equals` to `email ILIKE $1`
        // WITHOUT escaping the value, so `_` and `%` (both legal in an address)
        // would be wildcards and `a_min@corp.test` would resolve to
        // `admin@corp.test` (account takeover through social login, a fresh
        // login-throttle budget per pattern). Escape them, and re-check the match
        // in code so no provider's pattern semantics can return another account.
        const rows = (await this.client.authUser.findMany({
          where: { email: { equals: escapeLikePattern(canonical), mode: 'insensitive' } },
          orderBy: { id: 'asc' },
          take: 2,
        })) as PUser[]
        const matches = rows.filter((r) => r.email.trim().toLowerCase() === canonical)
        if (matches.length > 1) throw new AccountEmailAmbiguousError(canonical)
        return matches[0] ? toUser(matches[0]) : null
      } catch (err) {
        // `mode: 'insensitive'` is PostgreSQL/MongoDB-only.
        if ((err as { name?: unknown } | null)?.name !== 'PrismaClientValidationError') throw err
        this.insensitiveUnsupported = true
      }
    }
    const r = await this.client.authUser.findUnique({ where: { email: canonical } })
    return r ? toUser(r) : null
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

  /**
   * Refuses an email that already exists in **any** letter case
   * ({@link EmailTakenError}): the `@unique` index on PostgreSQL is
   * case-sensitive, so a legacy `Bob@x.test` would not stop a new `bob@x.test`.
   * A concurrent insert of the same canonical email loses on the index (P2002)
   * and gets the same error.
   */
  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> {
    const email = data.email.trim().toLowerCase()
    const row = { id: randomUUID(), email, passwordHash: data.passwordHash, emailVerified: false }
    assertColumnLengths(PKG, this.limits, 'AuthUser', row)
    if (await this.findByEmail(email)) throw new EmailTakenError()
    try {
      const r = await this.client.authUser.create({ data: row })
      return toUser(r)
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') throw new EmailTakenError()
      throw err
    }
  }

  async update(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const data: Partial<PUser> = {}
    if (patch.passwordHash !== undefined) data.passwordHash = patch.passwordHash
    if (patch.emailVerified !== undefined) data.emailVerified = patch.emailVerified
    if (Object.keys(data).length === 0) return this.findById(id)
    assertColumnLengths(PKG, this.limits, 'AuthUser', data)
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
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async create(record: AuthTokenRecord): Promise<void> {
    const data = {
      token: record.token,
      userId: record.userId,
      purpose: record.purpose,
      expiresAt: at(record.expiresAt),
      usedAt: record.usedAt !== undefined ? at(record.usedAt) : null,
    }
    assertColumnLengths(PKG, this.limits, 'AuthToken', data)
    await this.client.authToken.create({ data })
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
  private readonly limits: AuthColumnLimits | undefined
  private readonly trackActivity: boolean
  /**
   * Records session activity for `AuthOptions.sessionIdleTtl`. Defined only
   * with `trackSessionActivity: true`, which needs the `lastSeenAt` column:
   * without it Auth refuses an idle timeout instead of writing a column the
   * database may not have.
   */
  readonly touch?: (id: string, at: number) => Promise<void>

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
    this.trackActivity = options.trackSessionActivity === true
    if (this.trackActivity) {
      this.touch = async (id: string, when: number): Promise<void> => {
        const updateMany = this.client.authSession.updateMany
        if (typeof updateMany !== 'function') {
          throw new TypeError('@basaltkit/auth-prisma: trackSessionActivity needs authSession.updateMany on the Prisma client.')
        }
        await updateMany.call(this.client.authSession, { where: { id: hashSessionId(id) }, data: { lastSeenAt: at(when) } })
      }
    }
  }

  async create(userId: string, ttlMs: number): Promise<SessionRecord> {
    // Mint a raw id for the client (cookie), but store its hash so a dump of the
    // session table can't be replayed as a live session.
    const rawId = randomBytes(32).toString('base64url')
    const now = Date.now()
    const expiresAt = now + ttlMs
    const data = {
      id: hashSessionId(rawId),
      userId,
      expiresAt: at(expiresAt),
      ...(this.trackActivity ? { lastSeenAt: at(now) } : {}),
    }
    assertColumnLengths(PKG, this.limits, 'AuthSession', data)
    await this.client.authSession.create({ data })
    return { id: rawId, userId, expiresAt, ...(this.trackActivity ? { lastSeenAt: now } : {}) }
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
    return {
      id,
      userId: r.userId,
      expiresAt,
      ...(r.lastSeenAt !== null && r.lastSeenAt !== undefined ? { lastSeenAt: ms(r.lastSeenAt) } : {}),
    }
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
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async create(record: RefreshRecord): Promise<void> {
    const data = {
      token: record.token,
      familyId: record.familyId,
      userId: record.userId,
      expiresAt: at(record.expiresAt),
      usedAt: record.usedAt !== undefined ? at(record.usedAt) : null,
    }
    assertColumnLengths(PKG, this.limits, 'AuthRefreshToken', data)
    await this.client.authRefreshToken.create({ data })
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
    scopes: stringList(r.scopes),
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
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  // Each query is wrapped so an un-migrated database surfaces as
  // AUTH_API_KEY_SCHEMA_OUTDATED instead of a raw "column does not exist".

  async create(record: ApiKeyRecord): Promise<void> {
    const data = {
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
    }
    assertColumnLengths(PKG, this.limits, 'AuthApiKey', data)
    try {
      await this.client.authApiKey.create({ data })
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
      // updateMany, not update: a key deleted meanwhile is a no-op (as in the
      // other stores), not a P2025 thrown out of verify().
      await this.client.authApiKey.updateMany({ where: { id }, data: { lastUsedAt: at(at_) } })
    } catch (err) {
      throw apiKeyError(err)
    }
  }

  async revoke(id: string, at_: number): Promise<void> {
    try {
      await this.client.authApiKey.updateMany({ where: { id }, data: { revokedAt: at(at_) } })
    } catch (err) {
      throw apiKeyError(err)
    }
  }
}

// --- MFA --------------------------------------------------------------------

export class PrismaMfaStore implements MfaStore {
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async get(userId: string): Promise<MfaRecord | null> {
    const r = await this.client.authMfa.findUnique({ where: { userId } })
    if (!r) return null
    return {
      secret: r.secret,
      enabled: r.enabled,
      recoveryCodes: stringList(r.recoveryCodes),
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
    assertColumnLengths(PKG, this.limits, 'AuthMfa', { userId, ...data })
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
      const codes = stringList(r.recoveryCodes)
      const index = codes.indexOf(hash)
      if (index === -1) return false
      const next = codes.filter((_, i) => i !== index)
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
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async get(userId: string): Promise<number> {
    return (await this.client.authTokenVersion.findUnique({ where: { userId } }))?.version ?? 0
  }

  async increment(userId: string): Promise<number> {
    assertColumnLengths(PKG, this.limits, 'AuthTokenVersion', { userId })
    const r = await this.client.authTokenVersion.upsert({
      where: { userId },
      create: { userId, version: 1 },
      update: { version: { increment: 1 } },
    })
    return r.version
  }
}

// --- legacy mixed-case emails ------------------------------------------------

export interface NormalizeEmailsReport {
  /** Rows whose email was rewritten to its canonical form (or would be, on a dry run). */
  normalized: Array<{ id: string; from: string; to: string }>
  /**
   * Canonical emails held by more than one row. They are left untouched —
   * which account is the real one is a decision for a human (merge, rename or
   * delete the others); until then lookups of that email throw
   * `AUTH_EMAIL_AMBIGUOUS`.
   */
  conflicts: Array<{ email: string; ids: string[] }>
}

/**
 * One-off migration for users written before emails were canonicalised
 * (trimmed, lowercased): rewrites every non-canonical email that has no
 * case-variant twin, and reports the twins. Idempotent; pages through the table
 * by id. Run it once after upgrading (`dryRun: true` to preview).
 */
export async function normalizeAuthUserEmails(
  client: Pick<PrismaAuthClient, 'authUser'>,
  options: { dryRun?: boolean; pageSize?: number } = {},
): Promise<NormalizeEmailsReport> {
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? 1000))
  const groups = new Map<string, Array<{ id: string; email: string }>>()
  let cursor: string | undefined
  for (;;) {
    const rows = await client.authUser.findMany({
      ...(cursor !== undefined ? { where: { id: { gt: cursor } } } : {}),
      select: { id: true, email: true },
      orderBy: { id: 'asc' },
      take: pageSize,
    })
    for (const r of rows) {
      const canonical = r.email.trim().toLowerCase()
      const group = groups.get(canonical)
      if (group) group.push({ id: r.id, email: r.email })
      else groups.set(canonical, [{ id: r.id, email: r.email }])
    }
    if (rows.length < pageSize) break
    cursor = rows[rows.length - 1]!.id
  }
  const report: NormalizeEmailsReport = { normalized: [], conflicts: [] }
  for (const [canonical, rows] of groups) {
    if (rows.length > 1) {
      report.conflicts.push({ email: canonical, ids: rows.map((r) => r.id) })
      continue
    }
    const row = rows[0]!
    if (row.email === canonical) continue
    if (!options.dryRun) await client.authUser.update({ where: { id: row.id }, data: { email: canonical } })
    report.normalized.push({ id: row.id, from: row.email, to: canonical })
  }
  return report
}

// --- federated identities (account links) -------------------------------------

/**
 * Primary key of a link / passkey row: SHA-256 (hex) of the natural key. OIDC
 * subjects run to 255 characters and credential ids to 1 023 bytes — too long
 * for an indexed `VARCHAR(191)` on MySQL — while 64 hex characters fit every
 * provider's default string column.
 */
const rowKey = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex')

/** The Prisma client was generated without a model a store needs. */
export class AuthModelMissingError extends BasaltError {
  readonly status = 500
  readonly expose = false
  constructor(delegate: string, model: string) {
    super(
      'AUTH_PRISMA_MODEL_MISSING',
      `The Prisma client has no \`${delegate}\` model. Add \`model ${model}\` from '@basaltkit/auth-prisma/schema.prisma' ` +
        '(or run `basalt prisma:sync`), migrate, and run `prisma generate`.',
    )
  }
}

const toLink = (r: PAccountLink): AccountLink => ({
  provider: r.provider,
  subject: r.subject,
  userId: r.userId,
  email: r.email,
  createdAt: ms(r.createdAt),
})

export class PrismaAccountLinkStore implements AccountLinkStore {
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  private get links(): NonNullable<PrismaAuthClient['authAccountLink']> {
    const delegate = this.client.authAccountLink
    if (!delegate) throw new AuthModelMissingError('authAccountLink', 'AuthAccountLink')
    return delegate
  }

  async find(provider: string, subject: string): Promise<AccountLink | null> {
    const r = await this.links.findUnique({ where: { id: rowKey(provider, subject) } })
    // Re-check the natural key: never trust a hash match alone.
    return r && r.provider === provider && r.subject === subject ? toLink(r) : null
  }

  /** The primary key is the link itself, so the insert is the atomic check. */
  async create(link: AccountLink): Promise<boolean> {
    const data = {
      id: rowKey(link.provider, link.subject),
      provider: link.provider,
      subject: link.subject,
      userId: link.userId,
      email: link.email,
      createdAt: at(link.createdAt),
    }
    assertColumnLengths(PKG, this.limits, 'AuthAccountLink', data)
    try {
      await this.links.create({ data })
      return true
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'P2002') return false
      throw err
    }
  }

  async forUser(userId: string): Promise<AccountLink[]> {
    const rows = await this.links.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toLink)
  }

  async remove(provider: string, subject: string): Promise<void> {
    await this.links.deleteMany({ where: { id: rowKey(provider, subject) } })
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.links.deleteMany({ where: { userId } })
  }
}

// --- WebAuthn passkeys --------------------------------------------------------

const toPasskey = (r: PPasskey): PasskeyCredential => {
  const cred: PasskeyCredential = {
    id: r.credentialId,
    userId: r.userId,
    publicKey: r.publicKey,
    counter: Number(r.counter),
    createdAt: ms(r.createdAt),
  }
  if (r.transports !== null) cred.transports = JSON.parse(r.transports) as string[]
  if (r.deviceName !== null) cred.deviceName = r.deviceName
  if (r.lastUsedAt !== null) cred.lastUsedAt = ms(r.lastUsedAt)
  return cred
}

/**
 * `PasskeyStore` over the `AuthPasskey` model. The counter is a `BigInt`
 * column (the WebAuthn counter is an unsigned 32-bit value, past `Int`), and
 * `transports` is JSON text rather than a scalar list, so the model works on
 * MySQL as well as PostgreSQL.
 */
export class PrismaPasskeyStore implements PasskeyStore {
  private readonly limits: AuthColumnLimits | undefined

  constructor(
    private readonly client: PrismaAuthClient,
    options: PrismaAuthStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  private get passkeys(): NonNullable<PrismaAuthClient['authPasskey']> {
    const delegate = this.client.authPasskey
    if (!delegate) throw new AuthModelMissingError('authPasskey', 'AuthPasskey')
    return delegate
  }

  async add(credential: PasskeyCredential): Promise<void> {
    const data = {
      id: rowKey(credential.id),
      credentialId: credential.id,
      userId: credential.userId,
      publicKey: credential.publicKey,
      counter: BigInt(credential.counter),
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      deviceName: credential.deviceName ?? null,
      createdAt: at(credential.createdAt),
      lastUsedAt: credential.lastUsedAt !== undefined ? at(credential.lastUsedAt) : null,
    }
    assertColumnLengths(PKG, this.limits, 'AuthPasskey', data)
    await this.passkeys.create({ data })
  }

  async get(credentialId: string): Promise<PasskeyCredential | null> {
    const r = await this.passkeys.findUnique({ where: { id: rowKey(credentialId) } })
    return r && r.credentialId === credentialId ? toPasskey(r) : null
  }

  async forUser(userId: string): Promise<PasskeyCredential[]> {
    const rows = await this.passkeys.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
    return rows.map(toPasskey)
  }

  /** One conditional UPDATE: a concurrent assertion that moved the counter makes this one fail. */
  async compareAndSetCounter(credentialId: string, expected: number, next: number, lastUsedAt: number): Promise<boolean> {
    const { count } = await this.passkeys.updateMany({
      where: { id: rowKey(credentialId), counter: BigInt(expected) },
      data: { counter: BigInt(next), lastUsedAt: at(lastUsedAt) },
    })
    return count > 0
  }

  async remove(credentialId: string): Promise<void> {
    await this.passkeys.deleteMany({ where: { id: rowKey(credentialId) } })
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
  /** Needs the `AuthAccountLink` model (checked at first use). */
  accountLinks: PrismaAccountLinkStore
  /** Needs the `AuthPasskey` model (checked at first use). */
  passkeys: PrismaPasskeyStore
}

/**
 * Wire every auth store to your Prisma client, named to drop straight into
 * `authPlugin` / `apiKeysPlugin`:
 *
 * ```ts
 * const s = prismaAuthStores(prisma) // on MySQL: prismaAuthStores(prisma, { columnLimits: 'mysql' })
 * authPlugin({ users: s.users, sessions: s.sessions, refreshTokens: s.refreshTokens,
 *              tokens: s.tokens, mfa: s.mfa, accountLinks: s.accountLinks, secret })
 * apiKeysPlugin({ store: s.apiKeys, users: s.users })
 * webauthnPlugin({ config, verifier, credentials: s.passkeys })
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

export function prismaAuthStores(client: PrismaAuthClient, options: PrismaAuthStoreOptions = {}): PrismaAuthStores {
  ensureModel(client, 'authUser', PKG)
  return {
    users: new PrismaUserSource(client, options),
    sessions: new PrismaSessionStore(client, options),
    refreshTokens: new PrismaRefreshTokenStore(client, options),
    tokens: new PrismaAuthTokenStore(client, options),
    apiKeys: new PrismaApiKeyStore(client, options),
    mfa: new PrismaMfaStore(client, options),
    tokenVersions: new PrismaTokenVersionStore(client, options),
    accountLinks: new PrismaAccountLinkStore(client, options),
    passkeys: new PrismaPasskeyStore(client, options),
  }
}
