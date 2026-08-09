import { describe, expect, it } from 'vitest'
import { PrismaTenantSource, type PrismaTenancyClient, prismaTenantSource } from '../src/index.js'

// In-memory fake of the Prisma delegate surface — the injectable-client pattern.
function makeFakeClient(): PrismaTenancyClient {
  const tenants = new Map<string, { id: string; data: unknown }>()
  const domains = new Map<string, { domain: string; tenantId: string }>()

  return {
    tenant: {
      async findUnique({ where }) {
        return tenants.get(where.id) ?? null
      },
      async findMany({ orderBy }) {
        const rows = [...tenants.values()]
        if (orderBy?.id === 'asc') rows.sort((a, b) => a.id.localeCompare(b.id))
        return rows
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
        // cascade domains
        for (const [key, d] of domains) if (d.tenantId === where.id) domains.delete(key)
        return { count }
      },
    },
    tenantDomain: {
      async findUnique({ where }) {
        return domains.get(where.domain) ?? null
      },
      async deleteMany({ where }) {
        let count = 0
        for (const [key, d] of domains) {
          if (d.tenantId === where.tenantId) {
            domains.delete(key)
            count++
          }
        }
        return { count }
      },
      async createMany({ data }) {
        for (const row of data as { domain: string; tenantId: string }[]) {
          if (domains.has(row.domain)) throw new Error(`unique constraint: ${row.domain}`)
          domains.set(row.domain, row)
        }
        return { count: (data as unknown[]).length }
      },
    },
  }
}

describe('PrismaTenantSource', () => {
  it('saves, finds and lists open tenant records', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
    await source.save({ id: 'globex', name: 'Globex' })

    expect(await source.find('acme')).toEqual({
      id: 'acme',
      name: 'Acme Inc',
      plan: 'pro',
      domains: ['app.acme.com'],
    })
    expect(await source.find('ghost')).toBeNull()
    expect((await source.list()).map((t) => t.id)).toEqual(['acme', 'globex'])
  })

  it('resolves a tenant by custom domain', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.save({ id: 'acme', domains: ['app.acme.com', 'acme.example'] })

    expect((await source.findByDomain('acme.example'))?.id).toBe('acme')
    expect(await source.findByDomain('unknown.com')).toBeNull()
  })

  it('replaces the domain set on re-save (adds and drops)', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.save({ id: 'acme', domains: ['old.acme.com'] })
    await source.save({ id: 'acme', domains: ['new.acme.com'] })

    expect(await source.findByDomain('old.acme.com')).toBeNull()
    expect((await source.findByDomain('new.acme.com'))?.id).toBe('acme')
  })

  it('rejects claiming a domain owned by another tenant, before writing', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.save({ id: 'acme', domains: ['shared.com'] })

    await expect(
      source.save({ id: 'globex', name: 'Globex', domains: ['shared.com'] }),
    ).rejects.toThrow(/already owned by tenant "acme"/)
    // rejected up front — nothing was written for globex
    expect(await source.find('globex')).toBeNull()
    expect((await source.findByDomain('shared.com'))?.id).toBe('acme')
  })

  it('removes a tenant and cascades its domains', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.save({ id: 'acme', domains: ['app.acme.com'] })

    expect(await source.remove('acme')).toBe(true)
    expect(await source.remove('acme')).toBe(false)
    expect(await source.find('acme')).toBeNull()
    expect(await source.findByDomain('app.acme.com')).toBeNull()
  })
})

describe('prismaTenantSource', () => {
  it('returns a source ready for tenancyPlugin({ source })', () => {
    expect(prismaTenantSource(makeFakeClient())).toBeInstanceOf(PrismaTenantSource)
  })

  it('fails fast when the client lacks the Tenant model', () => {
    expect(() => prismaTenantSource({} as unknown as PrismaTenancyClient)).toThrow(
      /has no `tenant` model/,
    )
  })
})
