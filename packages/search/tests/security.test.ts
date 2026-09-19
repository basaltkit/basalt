import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { MemorySearchDriver, Search, SearchTenantMismatchError, defineIndex } from '../src/index.js'

const notes = defineIndex({ name: 'notes', fields: ['title'] })

async function setup() {
  const driver = new MemorySearchDriver()
  await driver.register(notes)
  await driver.bulk('notes', [
    { id: '1', tenantId: 'acme', title: 'quick acme note' },
    { id: '9', tenantId: 'globex', title: 'quick globex secret' },
  ])
  return { driver, search: new Search({ driver }, () => true) }
}

// Search methods resolve the tenant synchronously; wrap to observe a rejection.
const inAcme = <T>(fn: () => Promise<T>) => runWithContext({ tenant: { id: 'acme' } } as never, async () => fn())

describe('F59 · an explicit tenantId never widens past the context tenant', () => {
  it('search() refuses another tenant named by the caller (e.g. forwarded ?tenantId=)', async () => {
    const { search } = await setup()
    await expect(inAcme(() => search.search('notes', 'quick', { tenantId: 'globex' }))).rejects.toBeInstanceOf(
      SearchTenantMismatchError,
    )
    // The authorize path takes the same rule.
    await expect(
      inAcme(() => search.search('notes', 'quick', { tenantId: 'globex', authorize: (h) => h })),
    ).rejects.toBeInstanceOf(SearchTenantMismatchError)
    const own = await inAcme(() => search.search('notes', 'quick', { tenantId: 'acme' }))
    expect(own.hits.map((h) => h.id)).toEqual(['1'])
  })

  it('index()/bulk()/remove() cannot plant or delete documents in another tenant', async () => {
    const { driver, search } = await setup()
    await expect(inAcme(() => search.index('notes', { id: 'x', tenantId: 'globex', title: 'quick planted' }))).rejects.toBeInstanceOf(
      SearchTenantMismatchError,
    )
    await expect(
      inAcme(() => search.bulk('notes', [{ id: 'y', tenantId: 'globex', title: 'quick planted' }])),
    ).rejects.toBeInstanceOf(SearchTenantMismatchError)
    await expect(inAcme(() => search.remove('notes', '9', 'globex'))).rejects.toBeInstanceOf(SearchTenantMismatchError)

    const globex = await driver.search('notes', { tenantId: 'globex', q: 'quick' })
    expect(globex.hits.map((h) => h.id)).toEqual(['9'])

    // A document without a tenant lands in the context tenant, as before.
    await inAcme(() => search.index('notes', { id: '2', title: 'quick second' }))
    expect((await driver.search('notes', { tenantId: 'acme', q: 'quick' })).hits.map((h) => h.id).sort()).toEqual(['1', '2'])
  })

  it('outside any tenant context an explicit tenant is still honoured (jobs, CLI)', async () => {
    const { search } = await setup()
    expect((await search.search('notes', 'quick', { tenantId: 'globex' })).hits.map((h) => h.id)).toEqual(['9'])
  })
})
