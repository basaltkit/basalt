import { describe, expect, it } from 'vitest'
import { TenantAlreadyExistsError } from '@basaltkit/tenancy'
import { PrismaTenantSource, type PrismaTenancyClient, prismaTenantSource } from '../src/index.js'

// In-memory fake of the Prisma delegate surface — the injectable-client pattern.
function makeFakeClient(): PrismaTenancyClient {
  const tenants = new Map<string, { id: string; data: unknown }>()
  const domains = new Map<string, { domain: string; tenantId: string }>()

  const client: PrismaTenancyClient = {
    // Interactive transaction: all-or-nothing, like Prisma's — the callback's
    // writes are rolled back when it throws.
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
      // Mirrors Prisma: a duplicate primary key rejects with
      // PrismaClientKnownRequestError, code P2002.
      async create({ data }) {
        if (tenants.has(data.id)) {
          throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
        }
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
          if (domains.has(row.domain)) {
            throw Object.assign(new Error(`Unique constraint failed on the fields: (\`domain\`)`), { code: 'P2002' })
          }
          domains.set(row.domain, row)
        }
        return { count: (data as unknown[]).length }
      },
    },
  }
  return client
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

  it('create() inserts a new tenant with its domains', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.create({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })

    expect(await source.find('acme')).toEqual({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it('create() refuses an existing id and leaves the first record intact', async () => {
    // The bug this closes: create went through the upsert, and a second signup
    // for the same id replaced the owner, the status and the domain set.
    const source = new PrismaTenantSource(makeFakeClient())
    await source.create({ id: 'acme', name: 'Acme', ownerUserId: 'u1', domains: ['app.acme.com'] })

    const duplicate = source.create({ id: 'acme', name: 'Impostor', domains: ['other.com'] })
    await expect(duplicate).rejects.toBeInstanceOf(TenantAlreadyExistsError)
    await expect(source.create({ id: 'acme' })).rejects.toMatchObject({ code: 'TENANT_ALREADY_EXISTS', status: 409 })

    expect(await source.find('acme')).toEqual({
      id: 'acme',
      name: 'Acme',
      ownerUserId: 'u1',
      domains: ['app.acme.com'],
    })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
    expect(await source.findByDomain('other.com')).toBeNull()
  })

  it('create() rejects a domain owned by another tenant, before writing', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.create({ id: 'acme', domains: ['shared.com'] })

    await expect(source.create({ id: 'globex', domains: ['shared.com'] })).rejects.toThrow(
      /already owned by tenant "acme"/,
    )
    expect(await source.find('globex')).toBeNull()
  })

  it('create() rethrows errors that are not a duplicate id', async () => {
    const client = makeFakeClient()
    client.tenant.create = async () => {
      throw Object.assign(new Error('connection lost'), { code: 'P1001' })
    }
    await expect(new PrismaTenantSource(client).create({ id: 'acme' })).rejects.toThrow('connection lost')
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

// FA-068: save/create wrote the tenant, deleted its domains and re-inserted
// them as separate statements. Any failure after the delete — a domain listed
// twice, or claimed by another tenant between the pre-flight and the insert —
// left the tenant rewritten and its existing domains gone.
describe('save()/create() are atomic (FA-068)', () => {
  it('a domain listed twice is stored once, without losing the tenant', async () => {
    const source = new PrismaTenantSource(makeFakeClient())
    await source.save({ id: 'acme', domains: ['old.acme.com'] })
    await source.save({ id: 'acme', name: 'Acme', domains: ['app.acme.com', 'app.acme.com'] })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
    expect(await source.findByDomain('old.acme.com')).toBeNull()
  })

  it('a domain claimed by another tenant mid-save rolls the whole save back', async () => {
    const client = makeFakeClient()
    const source = new PrismaTenantSource(client)
    await source.save({ id: 'acme', name: 'Acme', domains: ['old.acme.com'] })
    await source.save({ id: 'globex', name: 'Globex' })

    // globex claims the domain right after acme's pre-flight read of it
    const findUnique = client.tenantDomain.findUnique.bind(client.tenantDomain)
    client.tenantDomain.findUnique = async (args) => {
      const owner = await findUnique(args)
      if (args.where.domain === 'new.acme.com') {
        await client.tenantDomain.createMany({ data: [{ domain: 'new.acme.com', tenantId: 'globex' }] })
      }
      return owner
    }

    await expect(source.save({ id: 'acme', name: 'Renamed', domains: ['new.acme.com'] })).rejects.toThrow(
      /new\.acme\.com|domain/,
    )
    expect(await source.find('acme')).toEqual({ id: 'acme', name: 'Acme', domains: ['old.acme.com'] })
    expect((await source.findByDomain('old.acme.com'))?.id).toBe('acme')
  })

  it('create(): a domain failure leaves no half-created tenant behind', async () => {
    const client = makeFakeClient()
    const source = new PrismaTenantSource(client)
    client.tenantDomain.createMany = async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    }
    await expect(source.create({ id: 'acme', domains: ['app.acme.com'] })).rejects.toThrow()
    expect(await source.find('acme')).toBeNull()
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

/**
 * `tenancy.create()` against the real source — because a fake with the right
 * shape is exactly what failed to catch two bugs here. It once required
 * `create()` when this source had only `save()` (TENANT_CREATE_UNSUPPORTED in a
 * real app, tenancy 1.5.0); then, falling back to that upsert, it silently
 * overwrote an existing tenant. The source now has an insert-only `create()`,
 * and status transitions still go through `save()`.
 */
describe('usable by tenancy.create()', () => {
  const hooksFor = (announced: string[]) =>
    // Minimal hook bus — this asserts the source, not the container wiring.
    ({ emit: async (_n: string, p: { tenant: { id: string } }) => void announced.push(p.tenant.id) }) as never

  it('creates, provisions and announces', async () => {
    const { Tenancy } = await import('@basaltkit/tenancy')

    const source = prismaTenantSource(makeFakeClient())
    const provisioned: string[] = []
    const announced: string[] = []
    // Minimal hook bus — this asserts the source, not the container wiring.
    const hooks = { emit: async (_n: string, p: { tenant: { id: string } }) => void announced.push(p.tenant.id) }

    const tenancy = new Tenancy(source, [], hooks as never, (t) => void provisioned.push(t.id))
    const tenant = await tenancy.create({ id: 'acme', name: 'Acme' })

    expect(tenant).toMatchObject({ id: 'acme', name: 'Acme' })
    // provisioning → ready went through save(), the upsert, after create().
    expect(await source.find('acme')).toMatchObject({ id: 'acme', status: 'ready' })
    expect(provisioned).toEqual(['acme'])
    // 'tenancy:switched' fires when provisioning enters the context, then
    // 'tenancy:created' — the last one is the announcement.
    expect(announced.at(-1)).toBe('acme')
  })

  it('marks a tenant failed when provisioning throws', async () => {
    const { Tenancy } = await import('@basaltkit/tenancy')
    const source = prismaTenantSource(makeFakeClient())
    const tenancy = new Tenancy(source, [], hooksFor([]), () => {
      throw new Error('CREATE SCHEMA denied')
    })

    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow('CREATE SCHEMA denied')
    expect(await source.find('acme')).toMatchObject({ status: 'failed' })
  })

  it('refuses to create an existing tenant and leaves it untouched', async () => {
    const { Tenancy } = await import('@basaltkit/tenancy')
    const source = prismaTenantSource(makeFakeClient())
    const provisioned: string[] = []
    const tenancy = new Tenancy(source, [], hooksFor([]), (t) => void provisioned.push(t.id))

    await tenancy.create({ id: 'acme', name: 'Acme', ownerUserId: 'u1' })
    await expect(tenancy.create({ id: 'acme', name: 'Other' })).rejects.toBeInstanceOf(TenantAlreadyExistsError)

    expect(await source.find('acme')).toMatchObject({ name: 'Acme', ownerUserId: 'u1', status: 'ready' })
    expect(provisioned).toEqual(['acme'])
  })

  it('lets exactly one of two concurrent creates of the same id win', async () => {
    // Both pass tenancy.create's find() pre-check; the insert decides.
    const { Tenancy } = await import('@basaltkit/tenancy')
    const source = prismaTenantSource(makeFakeClient())
    const provisioned: string[] = []
    const tenancy = new Tenancy(source, [], hooksFor([]), (t) => void provisioned.push(String(t['name'])))

    const results = await Promise.allSettled([
      tenancy.create({ id: 'acme', name: 'first' }),
      tenancy.create({ id: 'acme', name: 'second' }),
    ])

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toBeInstanceOf(TenantAlreadyExistsError)
    expect(provisioned).toHaveLength(1)
    expect((await source.find('acme'))?.['name']).toBe(provisioned[0])
  })
})
