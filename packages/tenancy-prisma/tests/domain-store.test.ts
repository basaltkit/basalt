import { describe, expect, it } from 'vitest'
import { CustomDomains, DomainTakenError, Tenancy } from '@basaltkit/tenancy'
import { domainStoreContract } from '@basaltkit/tenancy/testing'
import { PrismaDomainStore, PrismaTenantSource, prismaDomainStore, type PrismaDomainStoreClient } from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

/** A client with the two tenants the contract uses already in place (the FK needs them). */
async function seeded() {
  const client = makeFakeClient()
  const source = new PrismaTenantSource(client)
  await source.create({ id: 'acme' })
  await source.create({ id: 'globex' })
  return { client, source }
}

describe('PrismaDomainStore honours the DomainStore contract', () => {
  for (const c of domainStoreContract(async () => new PrismaDomainStore((await seeded()).client))) it(c.name, c.run)
})

const txt = (records: Record<string, string>) => async (host: string) => {
  const value = records[host]
  if (value === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return [[value]]
}

/** CustomDomains over the durable store, with a DNS answer the test controls. */
async function setup() {
  const { client, source } = await seeded()
  const records: Record<string, string> = {}
  const domains = new CustomDomains({ store: prismaDomainStore(client), resolveTxt: txt(records) })
  const publish = async (tenantId: string, domain: string) => {
    const dns = await domains.instructions(tenantId, domain)
    records[dns.host] = dns.value
  }
  return { client, source, domains, publish }
}

describe('PrismaTenantSource and PrismaDomainStore share tenant_domains (BK-042)', () => {
  it('a verified custom domain resolves through the source', async () => {
    const { source, domains, publish } = await setup()
    await domains.add('acme', 'docs.acme.com')
    await publish('acme', 'docs.acme.com')
    expect(await domains.verify('acme', 'docs.acme.com')).toBe(true)
    expect((await source.findByDomain('docs.acme.com'))?.id).toBe('acme')
  })

  it('an unverified claim never resolves a request (fail-closed)', async () => {
    const { source, domains } = await setup()
    // globex claims a domain it does not own; it must not route to globex.
    await domains.add('globex', 'victim.com')
    expect(await source.findByDomain('victim.com')).toBeNull()
  })

  it('a claim that loses its proof stops resolving', async () => {
    const { source, domains, publish, client } = await setup()
    await domains.add('acme', 'docs.acme.com')
    await publish('acme', 'docs.acme.com')
    await domains.verify('acme', 'docs.acme.com')
    await prismaDomainStore(client).markUnverified('docs.acme.com')
    expect(await source.findByDomain('docs.acme.com')).toBeNull()
  })

  it('save() keeps a verified custom domain and its proof', async () => {
    const { source, domains, publish } = await setup()
    await source.save({ id: 'acme', domains: ['acme.example.com'] })
    await domains.add('acme', 'docs.acme.com')
    await publish('acme', 'docs.acme.com')
    await domains.verify('acme', 'docs.acme.com')
    const before = await domains.list('acme')

    // A status change rewrites the record without the custom domain in it.
    await source.save({ id: 'acme', status: 'suspended', domains: [] })

    expect(await domains.list('acme')).toEqual(before)
    expect((await source.findByDomain('docs.acme.com'))?.id).toBe('acme')
    // Its own mirror rows still follow tenant.domains.
    expect(await source.findByDomain('acme.example.com')).toBeNull()
  })

  it('re-provisioning a tenant keeps its verified custom domain', async () => {
    // tenancy.provision() writes status 'ready' through source.save() and is
    // re-runnable by design: it used to delete every domain of the tenant.
    const { source, domains, publish } = await setup()
    const hooks = { emit: async () => {} } as never
    const tenancy = new Tenancy(source, [], hooks, () => {})
    await tenancy.create({ id: 'initech', domains: ['initech.example.com'] })
    await domains.add('initech', 'portal.initech.com')
    await publish('initech', 'portal.initech.com')
    await domains.verify('initech', 'portal.initech.com')

    await tenancy.provision('initech')

    expect((await domains.list('initech')).map((d) => [d.domain, d.verified])).toEqual([['portal.initech.com', true]])
    expect((await source.findByDomain('portal.initech.com'))?.id).toBe('initech')
    expect((await source.findByDomain('initech.example.com'))?.id).toBe('initech')
  })

  it('a domain already on tenant.domains cannot also be claimed', async () => {
    const { source, domains } = await setup()
    await source.save({ id: 'acme', domains: ['app.acme.com'] })
    await expect(domains.add('globex', 'app.acme.com')).rejects.toBeInstanceOf(DomainTakenError)
    // the mirror row is not the store's: invisible to it, and kept
    expect(await domains.list('acme')).toEqual([])
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it("the store never removes or rewrites the source's mirror rows", async () => {
    const { source, client } = await setup()
    await source.save({ id: 'acme', domains: ['app.acme.com'] })
    const store = prismaDomainStore(client)
    expect(await store.get('app.acme.com')).toBeNull()
    await store.remove('app.acme.com')
    await store.markUnverified('app.acme.com')
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it('save() leaves alone a listed domain the tenant holds as a claim', async () => {
    const { source, domains } = await setup()
    await domains.add('acme', 'docs.acme.com')
    await source.save({ id: 'acme', domains: ['docs.acme.com'] })
    // still the claim (unverified), so still not routable
    expect((await domains.list('acme')).map((d) => d.domain)).toEqual(['docs.acme.com'])
    expect(await source.findByDomain('docs.acme.com')).toBeNull()
  })

  it('of two concurrent take-overs of an expired claim, exactly one wins', async () => {
    let now = 1_000
    const { client } = await seeded()
    await new PrismaTenantSource(client).create({ id: 'initech' })
    const store = prismaDomainStore(client)
    const domains = new CustomDomains({ store, now: () => now, claimTtlMs: 10, resolveTxt: txt({}) })
    await domains.add('acme', 'squatted.example')
    now += 100
    const results = await Promise.allSettled([
      domains.add('globex', 'squatted.example'),
      domains.add('initech', 'squatted.example'),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(loser?.reason).toBeInstanceOf(DomainTakenError)
    expect(['globex', 'initech']).toContain((await store.get('squatted.example'))?.tenantId)
  })
})

describe('prismaDomainStore', () => {
  it('fails fast when the client lacks the TenantDomain model', () => {
    expect(() => prismaDomainStore({} as unknown as PrismaDomainStoreClient)).toThrow(/has no `tenantDomain` model/)
  })

  it('rethrows errors that are not a unique violation', async () => {
    const client = makeFakeClient()
    client.tenantDomain.create = async () => {
      throw Object.assign(new Error('connection lost'), { code: 'P1001' })
    }
    await expect(
      new PrismaDomainStore(client).add({
        domain: 'a.example',
        tenantId: 'acme',
        verified: false,
        verificationToken: 't',
        createdAt: 1,
      }),
    ).rejects.toThrow('connection lost')
  })
})
