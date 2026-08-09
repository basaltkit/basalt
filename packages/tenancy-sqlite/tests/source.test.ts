import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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
  const dir = mkdtempSync(join(tmpdir(), 'machize-tenancy-'))
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
