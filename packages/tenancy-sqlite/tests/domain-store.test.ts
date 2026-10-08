import { describe, expect, it } from 'vitest'
import { CustomDomains, DomainTakenError, Tenancy } from '@basaltkit/tenancy'
import { domainStoreContract } from '@basaltkit/tenancy/testing'
import { migrate, openTenancyDatabase, SqliteDomainStore, sqliteDomainStore, sqliteTenantSource } from '../src/index.js'

const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')

describe('SqliteDomainStore honours the DomainStore contract', () => {
  for (const c of domainStoreContract(() => new SqliteDomainStore(openTenancyDatabase()))) it(c.name, c.run)
})

const txt = (records: Record<string, string>) => async (host: string) => {
  const value = records[host]
  if (value === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
  return [[value]]
}

function setup() {
  const source = sqliteTenantSource()
  const records: Record<string, string> = {}
  const domains = new CustomDomains({ store: sqliteDomainStore(source.db), resolveTxt: txt(records) })
  const publish = async (tenantId: string, domain: string) => {
    const dns = await domains.instructions(tenantId, domain)
    records[dns.host] = dns.value
  }
  return { source, domains, publish }
}

describe('SqliteTenantSource and SqliteDomainStore share tenant_domains (BK-042)', () => {
  it('a verified custom domain resolves through the source; an unverified claim never does', async () => {
    const { source, domains, publish } = setup()
    await source.create({ id: 'acme' })
    await source.create({ id: 'globex' })
    await domains.add('acme', 'docs.acme.com')
    expect(await source.findByDomain('docs.acme.com')).toBeNull()
    await publish('acme', 'docs.acme.com')
    await domains.verify('acme', 'docs.acme.com')
    expect((await source.findByDomain('docs.acme.com'))?.id).toBe('acme')

    await domains.add('globex', 'victim.com')
    expect(await source.findByDomain('victim.com')).toBeNull()
  })

  it('re-provisioning and status changes keep a verified custom domain and its proof', async () => {
    const { source, domains, publish } = setup()
    const tenancy = new Tenancy(source, [], { emit: async () => {} } as never, () => {})
    await tenancy.create({ id: 'initech', domains: ['initech.example.com'] })
    await domains.add('initech', 'portal.initech.com')
    await publish('initech', 'portal.initech.com')
    await domains.verify('initech', 'portal.initech.com')
    const before = await domains.list('initech')

    await tenancy.provision('initech')
    await source.save({ id: 'initech', status: 'suspended', domains: ['new.initech.com'] })

    expect(await domains.list('initech')).toEqual(before)
    expect((await source.findByDomain('portal.initech.com'))?.id).toBe('initech')
    // mirror rows still follow tenant.domains
    expect(await source.findByDomain('initech.example.com')).toBeNull()
    expect((await source.findByDomain('new.initech.com'))?.id).toBe('initech')
  })

  it('a domain on tenant.domains cannot also be claimed, and the store never touches mirror rows', async () => {
    const { source, domains } = setup()
    await source.save({ id: 'acme', domains: ['app.acme.com'] })
    await source.save({ id: 'globex' })
    await expect(domains.add('globex', 'app.acme.com')).rejects.toBeInstanceOf(DomainTakenError)
    const store = sqliteDomainStore(source.db)
    expect(await store.get('app.acme.com')).toBeNull()
    await store.remove('app.acme.com')
    await store.markUnverified('app.acme.com')
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it('a domain listed twice is stored once', async () => {
    const { source } = setup()
    await source.save({ id: 'acme', domains: ['app.acme.com', 'app.acme.com'] })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it('migrates a database created before the verification columns existed', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE tenant_domains (domain TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
      INSERT INTO tenants VALUES ('acme', '{"id":"acme","domains":["app.acme.com"]}');
      INSERT INTO tenant_domains VALUES ('app.acme.com', 'acme');
    `)
    migrate(db)
    migrate(db) // idempotent
    const source = sqliteTenantSource(db)
    // the old row is a mirror row: it resolves, and a save keeps it
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
    await source.save({ id: 'acme', domains: ['app.acme.com'] })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
    const store = sqliteDomainStore(db)
    await store.add({ domain: 'docs.acme.com', tenantId: 'acme', verified: false, verificationToken: 't', createdAt: 5 })
    expect(await store.get('docs.acme.com')).toEqual({
      domain: 'docs.acme.com',
      tenantId: 'acme',
      verified: false,
      verificationToken: 't',
      createdAt: 5,
    })
  })
})
