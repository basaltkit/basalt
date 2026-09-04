import { describe, expect, it } from 'vitest'
import { MemoryTenantSource, Tenancy, type Tenant } from '../src/index.js'

/**
 * B19 · a tenant created with no domain, accepted in silence.
 *
 * `tenancy.create()` persists whatever it is given. Every durable source reads
 * the domains from one key — `tenant.domains` — and an application that does
 * not pass it gets a tenant with none, with no warning of any kind.
 *
 * The symptom never appears, because `subdomainResolver` slices the suffix off
 * the `Host` and answers without consulting the table. The firm serves traffic.
 * What does not exist is the *record* that the address belongs to it: so
 * `domainResolver` cannot find it, a custom domain cannot be attached, and
 * nothing stops two firms claiming the same address, because the uniqueness
 * lives in the table that stayed empty.
 *
 * The worst kind of gap: it does not break, it omits. An installation can run
 * for a year with an empty `tenant_domains` and only find out when the first
 * client asks for their own domain — by which point every historical row needs
 * backfilling.
 */

const tenancy = (canonicalDomain?: (tenant: Tenant) => string | undefined) => {
  const source = new MemoryTenantSource()
  return {
    source,
    service: new Tenancy(source, [], undefined, undefined, 'inline', undefined, canonicalDomain),
  }
}

const domainsOf = (tenant: Tenant | null): string[] =>
  ((tenant as { domains?: string[] } | null)?.domains ?? [])

describe('F-37 · canonicalDomain', () => {
  it('fills the domain the application would otherwise forget', async () => {
    const { source, service } = tenancy((t) => `${t.id}.lexfirma.ao`)
    await service.create({ id: 'acme' } as Tenant)

    expect(domainsOf(await source.find('acme'))).toEqual(['acme.lexfirma.ao'])
  })

  it('adds to the domains a tenant already declares, never replaces them', async () => {
    // The durable sources delete and reinsert the whole domain set on save, so
    // a canonical domain that replaced would erase the firm's own address the
    // first time anything called `create` again.
    const { source, service } = tenancy((t) => `${t.id}.lexfirma.ao`)
    await service.create({ id: 'acme', domains: ['acme.example'] } as Tenant)

    expect(domainsOf(await source.find('acme')).sort()).toEqual(['acme.example', 'acme.lexfirma.ao'])
  })

  it('does not duplicate a domain the tenant already had', async () => {
    const { source, service } = tenancy((t) => `${t.id}.lexfirma.ao`)
    await service.create({ id: 'acme', domains: ['acme.lexfirma.ao'] } as Tenant)

    expect(domainsOf(await source.find('acme'))).toEqual(['acme.lexfirma.ao'])
  })

  it('lets the function decline for a particular tenant', async () => {
    // An internal or system tenant may legitimately have no address.
    const { source, service } = tenancy((t) => (t.id === 'system' ? undefined : `${t.id}.x`))
    await service.create({ id: 'system' } as Tenant)

    expect(domainsOf(await source.find('system'))).toEqual([])
  })

  it('changes nothing when the application configures none', async () => {
    const { source, service } = tenancy()
    await service.create({ id: 'acme', domains: ['acme.example'] } as Tenant)

    expect(domainsOf(await source.find('acme'))).toEqual(['acme.example'])
  })
})
