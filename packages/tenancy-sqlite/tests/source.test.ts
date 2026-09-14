import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TenantAlreadyExistsError } from '@basaltkit/tenancy'
import { openTenancyDatabase, SqliteTenantSource, sqliteTenantSource } from '../src/index.js'

describe('SqliteTenantSource', () => {
  it('saves, finds and lists open tenant records', async () => {
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
    await source.save({ id: 'globex', name: 'Globex' })

    const acme = await source.find('acme')
    expect(acme).toEqual({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })
    expect(await source.find('ghost')).toBeNull()
    expect((await source.list()).map((t) => t.id)).toEqual(['acme', 'globex']) // ordered by id
  })

  it('resolves a tenant by custom domain', async () => {
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.save({ id: 'acme', domains: ['app.acme.com', 'acme.example'] })

    expect((await source.findByDomain('acme.example'))?.id).toBe('acme')
    expect(await source.findByDomain('unknown.com')).toBeNull()
  })

  it('replaces the domain set on re-save (adds and drops)', async () => {
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.save({ id: 'acme', domains: ['old.acme.com'] })
    await source.save({ id: 'acme', domains: ['new.acme.com'] })

    expect(await source.findByDomain('old.acme.com')).toBeNull() // dropped
    expect((await source.findByDomain('new.acme.com'))?.id).toBe('acme') // added
  })

  it('rejects claiming a domain owned by another tenant, atomically', async () => {
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.save({ id: 'acme', domains: ['shared.com'] })

    await expect(source.save({ id: 'globex', name: 'Globex', domains: ['shared.com'] })).rejects.toThrow()
    // the failed save rolled back — no half-written globex record
    expect(await source.find('globex')).toBeNull()
    expect((await source.findByDomain('shared.com'))?.id).toBe('acme')
  })

  it('create() inserts a new tenant with its domains', async () => {
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.create({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })

    expect(await source.find('acme')).toEqual({ id: 'acme', name: 'Acme', domains: ['app.acme.com'] })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it('create() refuses an existing id and leaves the first record intact', async () => {
    // The bug this closes: create went through the upsert, and a second signup
    // for the same id replaced the owner, the status and the domain set.
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.create({ id: 'acme', name: 'Acme', ownerUserId: 'u1', domains: ['app.acme.com'] })

    await expect(source.create({ id: 'acme', name: 'Impostor', domains: ['other.com'] })).rejects.toBeInstanceOf(
      TenantAlreadyExistsError,
    )
    await expect(source.create({ id: 'acme' })).rejects.toMatchObject({ code: 'TENANT_ALREADY_EXISTS', status: 409 })

    expect(await source.find('acme')).toEqual({ id: 'acme', name: 'Acme', ownerUserId: 'u1', domains: ['app.acme.com'] })
    expect((await source.findByDomain('app.acme.com'))?.id).toBe('acme')
    expect(await source.findByDomain('other.com')).toBeNull()
    // The failed transaction was rolled back, so the handle is still usable.
    await source.create({ id: 'globex' })
    expect((await source.find('globex'))?.id).toBe('globex')
  })

  it('create() rejects a domain owned by another tenant, atomically — not as a duplicate id', async () => {
    // The domain insert violates a key too; only the tenant insert may map to
    // TenantAlreadyExistsError.
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.create({ id: 'acme', domains: ['shared.com'] })

    const attempt = source.create({ id: 'globex', domains: ['shared.com'] })
    await expect(attempt).rejects.toThrow(/UNIQUE constraint failed: tenant_domains/)
    await expect(source.create({ id: 'globex', domains: ['shared.com'] })).rejects.not.toBeInstanceOf(
      TenantAlreadyExistsError,
    )
    expect(await source.find('globex')).toBeNull()
  })

  it('removes a tenant and its domains', async () => {
    const source = new SqliteTenantSource(openTenancyDatabase())
    await source.save({ id: 'acme', domains: ['app.acme.com'] })

    expect(await source.remove('acme')).toBe(true)
    expect(await source.remove('acme')).toBe(false) // already gone
    expect(await source.find('acme')).toBeNull()
    expect(await source.findByDomain('app.acme.com')).toBeNull()
  })
})

describe('sqliteTenantSource + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-tenancy-'))
  const file = join(dir, 'tenants.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns a source ready for tenancyPlugin({ source }) and exposes db', () => {
    const source = sqliteTenantSource()
    expect(source).toBeInstanceOf(SqliteTenantSource)
    expect(source.db).toBeDefined()
  })

  it('persists across connections (survives a restart)', async () => {
    await sqliteTenantSource(file).save({ id: 'acme', domains: ['app.acme.com'] })
    // A fresh handle to the same file — as if the process restarted.
    const reopened = sqliteTenantSource(file)
    expect((await reopened.find('acme'))?.id).toBe('acme')
    expect((await reopened.findByDomain('app.acme.com'))?.id).toBe('acme')
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openTenancyDatabase()
    const source = sqliteTenantSource(db)
    expect(source.db).toBe(db)
    await source.save({ id: 'acme' })
    expect((await new SqliteTenantSource(db).find('acme'))?.id).toBe('acme')
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

    const source = new SqliteTenantSource(openTenancyDatabase())
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
    const source = new SqliteTenantSource(openTenancyDatabase())
    const tenancy = new Tenancy(source, [], hooksFor([]), () => {
      throw new Error('CREATE SCHEMA denied')
    })

    await expect(tenancy.create({ id: 'acme' })).rejects.toThrow('CREATE SCHEMA denied')
    expect(await source.find('acme')).toMatchObject({ status: 'failed' })
  })

  it('refuses to create an existing tenant and leaves it untouched', async () => {
    const { Tenancy } = await import('@basaltkit/tenancy')
    const source = new SqliteTenantSource(openTenancyDatabase())
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
    const source = new SqliteTenantSource(openTenancyDatabase())
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
