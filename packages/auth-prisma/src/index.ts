import { createHash, randomBytes, randomUUID } from 'node:crypto'
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

/** A row as Prisma returns it (DateTime → Date, Boolean → boolean). */
interface PUser {
  id: string
  email: string
  passwordHash: string
  emailVerified: boolean
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

export class PrismaUserSource implements UserSource {
  constructor(private readonly client: PrismaAuthClient) {}

  async findByEmail(email: string): Promise<AuthUser | null> {
    const r = await this.client.authUser.findUnique({ where: { email } })
    return r ? toUser(r) : null
  }

  async findById(id: string): Promise<AuthUser | null> {
    const r = await this.client.authUser.findUnique({ where: { id } })
    return r ? toUser(r) : null
  }

  async create(data: { email: string; passwordHash: string }): Promise<AuthUser> {
    const r = await this.client.authUser.create({
      data: { id: randomUUID(), email: data.email, passwordHash: data.passwordHash, emailVerified: false },
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

  async markUsed(token: string): Promise<void> {
    await this.client.authToken.updateMany({ where: { token }, data: { usedAt: new Date() } })
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

  async markUsed(token: string): Promise<void> {
    await this.client.authRefreshToken.updateMany({ where: { token }, data: { usedAt: new Date() } })
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
  if (r.tenantId !== null) rec.tenantId = r.tenantId
  if (r.userId !== null) rec.userId = r.userId
  if (r.lastUsedAt !== null) rec.lastUsedAt = ms(r.lastUsedAt)
  if (r.revokedAt !== null) rec.revokedAt = ms(r.revokedAt)
  return rec
}

export class PrismaApiKeyStore implements ApiKeyStore {
  constructor(private readonly client: PrismaAuthClient) {}

  async create(record: ApiKeyRecord): Promise<void> {
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
        lastUsedAt: record.lastUsedAt !== undefined ? at(record.lastUsedAt) : null,
        revokedAt: record.revokedAt !== undefined ? at(record.revokedAt) : null,
      },
    })
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const r = await this.client.authApiKey.findUnique({ where: { hash } })
    return r ? toApiKey(r) : null
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    const r = await this.client.authApiKey.findUnique({ where: { id } })
    return r ? toApiKey(r) : null
  }

  async list(filter: ApiKeyFilter): Promise<ApiKeyRecord[]> {
    const where: { revokedAt: null; tenantId?: string; userId?: string } = { revokedAt: null }
    if (filter.tenantId !== undefined) where.tenantId = filter.tenantId
    if (filter.userId !== undefined) where.userId = filter.userId
    const rows = await this.client.authApiKey.findMany({ where, orderBy: { createdAt: 'asc' } })
    return rows.map(toApiKey)
  }

  async touch(id: string, at_: number): Promise<void> {
    await this.client.authApiKey.update({ where: { id }, data: { lastUsedAt: at(at_) } })
  }

  async revoke(id: string, at_: number): Promise<void> {
    await this.client.authApiKey.update({ where: { id }, data: { revokedAt: at(at_) } })
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
