import type { PrismaAuthClient } from '../src/index.js'

// A faithful in-memory fake of the Prisma delegate surface the stores use —
// the same "injectable client" pattern the cloud drivers test with. If a real
// PrismaClient satisfies `PrismaAuthClient`, so must this.
export interface FakeClientOptions {
  /**
   * `'postgresql'` (default): case-sensitive `@unique`, `mode: 'insensitive'`
   * supported. `'mysql'`: case-insensitive collation, and `mode` rejected with
   * a `PrismaClientValidationError`, as Prisma does.
   */
  provider?: 'postgresql' | 'mysql'
  /** Leave out the models added in 2.0, like a client generated before it. */
  withoutNewModels?: boolean
}

const uniqueViolation = (): Error => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })

export function makeFakeClient(options: FakeClientOptions = {}): PrismaAuthClient {
  const sameEmail = (a: string, b: string): boolean => (options.provider === 'mysql' ? a.toLowerCase() === b.toLowerCase() : a === b)
  const links = new Map<string, PLinkRow>()
  const passkeys = new Map<string, PPasskeyRow>()
  const users = new Map<string, PUserRow>()
  const sessions = new Map<string, PSessionRow>()
  const refresh = new Map<string, PRefreshRow>()
  const tokens = new Map<string, PTokenRow>()
  const apiKeys = new Map<string, PApiKeyRow>()
  const mfa = new Map<string, PMfaRow>()
  const versions = new Map<string, number>()

  const calls = { insensitive: 0 }
  const client: PrismaAuthClient & { calls: typeof calls } = {
    calls,
    authUser: {
      async findUnique({ where }) {
        if (where.id !== undefined) return users.get(where.id) ?? null
        if (where.email !== undefined) {
          // MySQL compares with a case-insensitive collation.
          for (const u of users.values()) if (sameEmail(u.email, where.email)) return u
        }
        return null
      },
      async findMany({ where, select, orderBy, take }) {
        let rows = [...users.values()]
        if (where?.id?.in !== undefined) {
          const ids = where.id.in as string[]
          rows = ids.flatMap((id) => {
            const u = users.get(id)
            return u ? [u] : []
          })
        }
        if (where?.id?.gt !== undefined) rows = rows.filter((u) => u.id > where.id.gt)
        if (where?.email !== undefined) {
          const wanted = where.email as { equals: string; mode?: string }
          if (wanted.mode === 'insensitive' && options.provider === 'mysql') {
            calls.insensitive++
            throw Object.assign(new Error('Unknown argument `mode`'), { name: 'PrismaClientValidationError' })
          }
          rows = rows.filter((u) => (wanted.mode === 'insensitive' ? ilike(u.email, wanted.equals) : u.email === wanted.equals))
        }
        if (orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        if (take !== undefined) rows = rows.slice(0, take)
        // Honour `select` the way Prisma does: unlisted columns (the hash
        // included) are simply absent from the objects that come back.
        if (!select) return rows
        return rows.map((u) => Object.fromEntries(Object.entries(u).filter(([k]) => select[k] === true))) as PUserRow[]
      },
      async create({ data }) {
        if ([...users.values()].some((u) => sameEmail(u.email, data.email))) throw uniqueViolation()
        const row = { ...data }
        users.set(row.id, row)
        return row
      },
      async update({ where, data }) {
        const row = users.get(where.id)
        if (!row) throw new Error('not found')
        if (data.email !== undefined && [...users.values()].some((u) => u.id !== row.id && sameEmail(u.email, data.email))) {
          throw uniqueViolation()
        }
        Object.assign(row, data)
        return row
      },
    },
    authSession: {
      async findUnique({ where }) {
        return sessions.get(where.id) ?? null
      },
      async create({ data }) {
        const row = { ...data }
        sessions.set(row.id, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = sessions.get(where.id)
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      async deleteMany({ where }) {
        return { count: sessions.delete(where.id) ? 1 : 0 }
      },
    },
    authRefreshToken: {
      async findUnique({ where }) {
        return refresh.get(where.token) ?? null
      },
      async create({ data }) {
        const row = { ...data }
        refresh.set(row.token, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = refresh.get(where.token)
        if (!row) return { count: 0 }
        // Honour the `usedAt: null` predicate — the store relies on it for CAS.
        if (where.usedAt === null && row.usedAt != null) return { count: 0 }
        row.usedAt = data.usedAt
        return { count: 1 }
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [k, r] of refresh) {
          if (where.familyId !== undefined && r.familyId !== where.familyId) continue
          if (where.userId !== undefined && r.userId !== where.userId) continue
          refresh.delete(k)
          count++
        }
        return { count }
      },
    },
    authToken: {
      async findUnique({ where }) {
        return tokens.get(where.token) ?? null
      },
      async create({ data }) {
        const row = { ...data }
        tokens.set(row.token, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = tokens.get(where.token)
        if (!row) return { count: 0 }
        // Honour the `usedAt: null` predicate — the store relies on it for CAS.
        if (where.usedAt === null && row.usedAt != null) return { count: 0 }
        row.usedAt = data.usedAt
        return { count: 1 }
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [k, r] of tokens) {
          if (r.userId === where.userId && r.purpose === where.purpose) {
            tokens.delete(k)
            count++
          }
        }
        return { count }
      },
    },
    authApiKey: {
      async findUnique({ where }) {
        if (where.id !== undefined) return apiKeys.get(where.id) ?? null
        if (where.hash !== undefined) {
          for (const k of apiKeys.values()) if (k.hash === where.hash) return k
        }
        return null
      },
      async findMany({ where, orderBy }) {
        let rows = [...apiKeys.values()].filter((k) => k.revokedAt === null)
        if (where.tenantId !== undefined) rows = rows.filter((k) => k.tenantId === where.tenantId)
        if (where.userId !== undefined) rows = rows.filter((k) => k.userId === where.userId)
        if (orderBy?.createdAt === 'asc') rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        return rows
      },
      async create({ data }) {
        if ([...apiKeys.values()].some((k) => k.hash === data.hash)) throw new Error('unique hash')
        const row = { ...data }
        apiKeys.set(row.id, row)
        return row
      },
      async updateMany({ where, data }) {
        const row = apiKeys.get(where.id)
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
    },
    authMfa: {
      // Rows come back as copies, as from a real database — so a read-modify-write
      // race in the store is observable here, not masked by shared references.
      async findUnique({ where }) {
        const row = mfa.get(where.userId)
        return row ? { ...row, recoveryCodes: [...row.recoveryCodes] } : null
      },
      // Supports the conditional updates the store issues (CAS semantics).
      async updateMany({ where, data }) {
        const row = mfa.get(where.userId)
        if (!row) return { count: 0 }
        if (where.enabled !== undefined && row.enabled !== where.enabled) return { count: 0 }
        if (where.OR) {
          const ok = (where.OR as Array<{ lastUsedStep: null | { lt: number } }>).some((c) =>
            c.lastUsedStep === null ? row.lastUsedStep === null : row.lastUsedStep !== null && row.lastUsedStep < c.lastUsedStep.lt,
          )
          if (!ok) return { count: 0 }
        }
        if (where.recoveryCodes?.equals !== undefined && JSON.stringify(row.recoveryCodes) !== JSON.stringify(where.recoveryCodes.equals)) {
          return { count: 0 }
        }
        Object.assign(row, data)
        return { count: 1 }
      },
      async upsert({ where, create, update }) {
        const existing = mfa.get(where.userId)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        mfa.set(row.userId, row)
        return row
      },
      async deleteMany({ where }) {
        return { count: mfa.delete(where.userId) ? 1 : 0 }
      },
    },
    authTokenVersion: {
      async findUnique({ where }: { where: { userId: string } }) {
        return versions.has(where.userId) ? { userId: where.userId, version: versions.get(where.userId)! } : null
      },
      async upsert({ where, create }: { where: { userId: string }; create: { version: number } }) {
        const v = versions.has(where.userId) ? versions.get(where.userId)! + 1 : create.version
        versions.set(where.userId, v)
        return { userId: where.userId, version: v }
      },
    },
    authAccountLink: {
      async findUnique({ where }) {
        const row = links.get(where.id)
        return row ? { ...row } : null
      },
      async findMany({ where }) {
        return [...links.values()].filter((l) => l.userId === where.userId).map((l) => ({ ...l }))
      },
      async create({ data }) {
        if (links.has(data.id)) throw uniqueViolation()
        links.set(data.id, { ...data })
        return { ...data }
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [k, l] of links) {
          if (where.id !== undefined && l.id !== where.id) continue
          if (where.userId !== undefined && l.userId !== where.userId) continue
          links.delete(k)
          count++
        }
        return { count }
      },
    },
    authPasskey: {
      async findUnique({ where }) {
        const row = passkeys.get(where.id)
        return row ? { ...row } : null
      },
      async findMany({ where }) {
        return [...passkeys.values()].filter((p) => p.userId === where.userId).map((p) => ({ ...p }))
      },
      async create({ data }) {
        if (passkeys.has(data.id)) throw uniqueViolation()
        passkeys.set(data.id, { ...data })
        return { ...data }
      },
      // Honours the `counter` predicate — the store's compare-and-set relies on it.
      async updateMany({ where, data }) {
        const row = passkeys.get(where.id)
        if (!row) return { count: 0 }
        if (where.counter !== undefined && BigInt(row.counter) !== BigInt(where.counter)) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
      async deleteMany({ where }) {
        return { count: passkeys.delete(where.id) ? 1 : 0 }
      },
    },
  }
  if (options.withoutNewModels) {
    delete client.authAccountLink
    delete client.authPasskey
  }
  return client
}

// row shapes the fake stores (Prisma-return shape: Date / boolean / null)
interface PUserRow { id: string; email: string; passwordHash: string; emailVerified: boolean }
interface PSessionRow { id: string; userId: string; expiresAt: Date; lastSeenAt?: Date | null }
interface PRefreshRow { token: string; familyId: string; userId: string; expiresAt: Date; usedAt: Date | null }
interface PTokenRow { token: string; userId: string; purpose: string; expiresAt: Date; usedAt: Date | null }
interface PApiKeyRow {
  id: string; name: string; prefix: string; hash: string; tenantId: string | null
  userId: string | null; scopes: string[]; createdAt: Date; expiresAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null
}
interface PLinkRow { id: string; provider: string; subject: string; userId: string; email: string; createdAt: Date }
interface PPasskeyRow {
  id: string; credentialId: string; userId: string; publicKey: string; counter: bigint
  transports: string | null; deviceName: string | null; createdAt: Date; lastUsedAt: Date | null
}
interface PMfaRow { userId: string; secret: string; enabled: boolean; recoveryCodes: string[]; lastUsedStep: number | null }


/**
 * On PostgreSQL, Prisma compiles `{ equals, mode: 'insensitive' }` to
 * `column ILIKE $1` WITHOUT escaping the value (verified against the Prisma 7
 * query compiler), so `%` and `_` in it are wildcards. Model that faithfully:
 * `_` = any one char, `%` = any run, `\` escapes the next char.
 */
function ilike(value: string, pattern: string): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\' && i + 1 < pattern.length) source += escapeRegExp(pattern[++i]!)
    else if (ch === '%') source += '[\\s\\S]*'
    else if (ch === '_') source += '[\\s\\S]'
    else source += escapeRegExp(ch)
  }
  return new RegExp(`^${source}$`, 'iu').test(value)
}
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
