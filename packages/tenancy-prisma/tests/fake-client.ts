import type { PrismaDomainStoreClient, PrismaTenancyClient, PTenantDomainRow } from '../src/index.js'

/**
 * In-memory fake of the Prisma delegate surface — the injectable-client
 * pattern. It mirrors the parts of Prisma the package relies on: interactive
 * transactions roll back on throw, a duplicate primary key rejects with code
 * P2002, a `TenantDomain` row gets the schema defaults (`verified: true`,
 * `createdAt: now()`, `verificationToken: null`), and `where` filters support
 * equality, `null`, `{ not: null }`, `{ in }` and `{ notIn }`.
 */
export type FakeClient = PrismaTenancyClient & PrismaDomainStoreClient

const unique = (field: string): Error =>
  Object.assign(new Error(`Unique constraint failed on the fields: (\`${field}\`)`), { code: 'P2002' })

type Condition = unknown

function matches(row: Record<string, unknown>, where: Record<string, Condition> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const c = condition as { not?: unknown; in?: unknown[]; notIn?: unknown[] }
      if ('not' in c) return c.not === null ? value !== null : value !== c.not
      if (c.in) return c.in.includes(value)
      if (c.notIn) return !c.notIn.includes(value)
      throw new Error(`fake client: unsupported filter on ${key}`)
    }
    return value === condition
  })
}

function withDefaults(data: Partial<PTenantDomainRow> & { domain: string; tenantId: string }): PTenantDomainRow {
  return {
    verificationToken: null,
    verified: true,
    createdAt: new Date(),
    verifiedAt: null,
    ...data,
  }
}

export function makeFakeClient(): FakeClient {
  const tenants = new Map<string, { id: string; data: unknown }>()
  const domains = new Map<string, PTenantDomainRow>()
  const copy = (row: PTenantDomainRow): PTenantDomainRow => ({ ...row })

  const client: FakeClient = {
    async $transaction(fn) {
      const savedTenants = new Map([...tenants].map(([k, v]) => [k, { ...v }]))
      const savedDomains = new Map([...domains].map(([k, v]) => [k, { ...v }]))
      try {
        return await fn(client)
      } catch (error) {
        tenants.clear()
        for (const [k, v] of savedTenants) tenants.set(k, v)
        domains.clear()
        for (const [k, v] of savedDomains) domains.set(k, v)
        throw error
      }
    },
    tenant: {
      async findUnique({ where }) {
        return tenants.get(where.id) ?? null
      },
      async findMany({ orderBy }) {
        const rows = [...tenants.values()]
        if (orderBy?.id === 'asc') rows.sort((a, b) => a.id.localeCompare(b.id))
        return rows
      },
      async create({ data }) {
        if (tenants.has(data.id)) throw unique('id')
        const row = { id: data.id, data: data.data }
        tenants.set(row.id, row)
        return row
      },
      async upsert({ where, create, update }) {
        const existing = tenants.get(where.id)
        if (existing) {
          existing.data = update.data
          return existing
        }
        const row = { id: create.id, data: create.data }
        tenants.set(row.id, row)
        return row
      },
      async deleteMany({ where }) {
        let count = 0
        if (tenants.delete(where.id)) count++
        // onDelete: Cascade
        for (const [key, d] of domains) if (d.tenantId === where.id) domains.delete(key)
        return { count }
      },
    },
    tenantDomain: {
      async findUnique({ where }) {
        const row = domains.get(where.domain)
        return row ? copy(row) : null
      },
      async findMany({ where, orderBy }) {
        const rows = [...domains.values()].filter((row) => matches(row as never, where)).map(copy)
        if (orderBy?.domain === 'asc') rows.sort((a, b) => a.domain.localeCompare(b.domain))
        return rows
      },
      async create({ data }) {
        if (domains.has(data.domain)) throw unique('domain')
        const row = withDefaults(data)
        domains.set(row.domain, row)
        return copy(row)
      },
      async createMany({ data }) {
        for (const row of data as PTenantDomainRow[]) {
          if (domains.has(row.domain)) throw unique('domain')
          domains.set(row.domain, withDefaults(row))
        }
        return { count: (data as unknown[]).length }
      },
      async updateMany({ where, data }) {
        const hits = [...domains.values()].filter((row) => matches(row as never, where))
        for (const row of hits) {
          const next = { ...row, ...data }
          if (next.domain !== row.domain && domains.has(next.domain)) throw unique('domain')
          domains.delete(row.domain)
          domains.set(next.domain, next)
        }
        return { count: hits.length }
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [key, row] of domains) {
          if (matches(row as never, where)) {
            domains.delete(key)
            count++
          }
        }
        return { count }
      },
    },
  }
  return client
}
