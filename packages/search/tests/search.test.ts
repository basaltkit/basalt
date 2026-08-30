import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import {
  MeilisearchDriver,
  MemorySearchDriver,
  SEARCH,
  Search,
  TenantRequiredError,
  defineIndex,
  searchPlugin,
  syncRule,
} from '../src/index.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'doc:created': { tenantId: string; id: string; title: string }
    'doc:deleted': { tenantId: string; id: string }
  }
}

const notesIndex = defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })

async function seed(): Promise<MemorySearchDriver> {
  const driver = new MemorySearchDriver()
  await driver.register(notesIndex)
  await driver.bulk('notes', [
    { id: '1', tenantId: 'acme', title: 'Quick brown fox', body: 'jumps over', folder: 'a', author: 'quick' },
    { id: '2', tenantId: 'acme', title: 'Slow green turtle', body: 'quick nap', folder: 'b', author: 'zed' },
    { id: '3', tenantId: 'acme', title: 'Quick quick quick', body: '', folder: 'a', author: 'zed' },
    { id: '9', tenantId: 'globex', title: 'Quick secret', body: '', folder: 'a', author: 'x' },
  ])
  return driver
}

describe('MemorySearchDriver', () => {
  it('scores by term frequency and prefix, most relevant first', async () => {
    const driver = await seed()
    const res = await driver.search('notes', { tenantId: 'acme', q: 'quick' })
    // doc 3 ("Quick quick quick") outranks docs 1 and 2
    expect(res.hits[0]!.id).toBe('3')
    expect(res.total).toBe(3) // docs 1, 2, 3 (not globex's 9)
    // prefix: 'qui' still matches 'quick'
    expect((await driver.search('notes', { tenantId: 'acme', q: 'qui' })).total).toBe(3)
  })

  it('requires every query term to match (AND semantics)', async () => {
    const driver = await seed()
    expect((await driver.search('notes', { tenantId: 'acme', q: 'quick brown' })).total).toBe(1) // only doc 1
    expect((await driver.search('notes', { tenantId: 'acme', q: 'quick nonexistent' })).total).toBe(0)
  })

  it('never returns another tenant’s documents', async () => {
    const driver = await seed()
    const res = await driver.search('notes', { tenantId: 'globex', q: 'quick' })
    expect(res.hits.map((h) => h.id)).toEqual(['9'])
  })

  it('only searches configured fields', async () => {
    const driver = await seed()
    // "zed" appears only in the (non-searchable) author field → no matches
    expect((await driver.search('notes', { tenantId: 'acme', q: 'zed' })).total).toBe(0)
  })

  it('applies exact and array filters', async () => {
    const driver = await seed()
    expect((await driver.search('notes', { tenantId: 'acme', q: 'quick', filters: { folder: 'a' } })).total).toBe(2)
    expect((await driver.search('notes', { tenantId: 'acme', q: 'quick', filters: { folder: ['b'] } })).total).toBe(1)
  })

  it('empty query lists all tenant docs; remove drops one', async () => {
    const driver = await seed()
    expect((await driver.search('notes', { tenantId: 'acme', q: '' })).total).toBe(3)
    await driver.remove('notes', 'acme', '1')
    expect((await driver.search('notes', { tenantId: 'acme', q: '' })).total).toBe(2)
  })

  it('honours limit and offset', async () => {
    const driver = await seed()
    const page = await driver.search('notes', { tenantId: 'acme', q: 'quick', limit: 1, offset: 1 })
    expect(page.hits).toHaveLength(1)
    expect(page.total).toBe(3)
  })
})

describe('Search service', () => {
  it('takes the tenant from the request context when omitted', async () => {
    const driver = await seed()
    const search = new Search({ driver })
    const res = await runWithContext({ tenant: { id: 'acme' } } as never, () => search.search('notes', 'quick'))
    expect(res.total).toBe(3)
  })

  it('throws when no tenant can be determined AND the app is multi-tenant', async () => {
    const search = new Search({ driver: await seed() }, () => true)
    await expect(search.search('notes', 'quick')).rejects.toBeInstanceOf(TenantRequiredError)
  })
})

describe('beyond-SaaS: search does not require tenancy', () => {
  /** Stands in for @basaltkit/tenancy: its only cross-package signal. */
  const fakeTenancyMarker = definePlugin({
    name: 'fake-tenancy-marker',
    register({ container }) {
      ensureMetadata(container).add('tenancy:active', true)
    },
  })

  it('with NO tenancy, index() and search() agree on one scope and never throw', async () => {
    const search = new Search({ driver: new MemorySearchDriver() })
    // No tenantId anywhere — a single-tenant app should not have to invent one.
    await search.index('notes', { id: 'n1', title: 'the quick brown fox' })
    await search.bulk('notes', [{ id: 'n2', title: 'quick start' }])

    const res = await search.search('notes', 'quick')
    expect(res.total).toBe(2)
    expect(res.hits.map((h) => h.id).sort()).toEqual(['n1', 'n2'])

    await search.remove('notes', 'n1')
    expect((await search.search('notes', 'quick')).total).toBe(1)
  })

  it('searchPlugin wires the tenancy signal from the container marker', async () => {
    const single = await createApp({ plugins: [searchPlugin({ driver: new MemorySearchDriver() })] }).boot()
    await single.container.get(SEARCH).search('notes', 'x') // must not throw
    await single.shutdown()

    const multi = await createApp({
      plugins: [fakeTenancyMarker, searchPlugin({ driver: new MemorySearchDriver() })],
    }).boot()
    await expect(multi.container.get(SEARCH).search('notes', 'x')).rejects.toBeInstanceOf(TenantRequiredError)
    await multi.shutdown()
  })
})

describe('searchPlugin sync bridge', () => {
  it('indexes on a create hook and removes on a delete hook', async () => {
    const app = await createApp({
      plugins: [
        searchPlugin({
          indexes: [defineIndex({ name: 'docs', fields: ['title'] })],
          sync: [
            syncRule({ hook: 'doc:created', index: 'docs', document: (p) => ({ id: p.id, tenantId: p.tenantId, title: p.title }) }),
            syncRule({ hook: 'doc:deleted', index: 'docs', remove: (p) => ({ tenantId: p.tenantId, id: p.id }) }),
          ],
        }),
      ],
    }).boot()
    const search = app.container.get(SEARCH)

    await app.hooks.emit('doc:created', { tenantId: 'acme', id: '1', title: 'hello world' })
    expect((await search.search('docs', 'hello', { tenantId: 'acme' })).total).toBe(1)

    await app.hooks.emit('doc:deleted', { tenantId: 'acme', id: '1' })
    expect((await search.search('docs', 'hello', { tenantId: 'acme' })).total).toBe(0)

    await app.shutdown()
  })
})

describe('searchPlugin register resilience', () => {
  const throwingDriver = {
    async register() {
      throw new Error('backend down')
    },
    async index() {},
    async bulk() {},
    async remove() {},
    async clear() {},
    async search() {
      return { hits: [], total: 0 }
    },
  }

  it('boots even when an index fails to register (default: warn, not crash)', async () => {
    const warn = console.warn
    console.warn = () => {} // silence the expected warning
    try {
      const app = await createApp({
        plugins: [searchPlugin({ driver: throwingDriver, indexes: [defineIndex({ name: 'notes', fields: ['title'] })] })],
      }).boot()
      expect(app.container.get(SEARCH)).toBeDefined()
      await app.shutdown()
    } finally {
      console.warn = warn
    }
  })

  it('throws on boot when failOnRegisterError is set', async () => {
    await expect(
      createApp({
        plugins: [
          searchPlugin({
            driver: throwingDriver,
            indexes: [defineIndex({ name: 'notes', fields: ['title'] })],
            failOnRegisterError: true,
          }),
        ],
      }).boot(),
    ).rejects.toThrow('backend down')
  })
})

interface Recorded {
  url: string
  method: string
  body: string | undefined
}
function meiliHarness(handler: (call: Recorded) => Response) {
  const calls: Recorded[] = []
  const fetchMock: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined })
    return handler(calls[calls.length - 1]!)
  }
  return { calls, driver: new MeilisearchDriver({ host: 'http://meili.test', apiKey: 'k', fetch: fetchMock }) }
}
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

describe('MeilisearchDriver', () => {
  it('register creates the index and declares tenant as filterable', async () => {
    const { calls, driver } = meiliHarness(() => ok({}))
    await driver.register(defineIndex({ name: 'notes', fields: ['title'], filterable: ['folder'] }))
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://meili.test/indexes' })
    const settings = calls.find((c) => c.url.endsWith('/settings'))!
    expect(JSON.parse(settings.body!).filterableAttributes).toEqual(['tenantId', 'folder'])
  })

  it('indexes documents with a collision-proof compound key', async () => {
    const { calls, driver } = meiliHarness(() => ok({}))
    await driver.index('notes', { id: '1', tenantId: 'acme', title: 'hi' })
    const put = calls[0]!
    expect(put.method).toBe('PUT')
    expect(JSON.parse(put.body!)[0]._pk).toBeTruthy()
  })

  it('constrains every search with a tenant filter and maps hits', async () => {
    const { calls, driver } = meiliHarness(() =>
      ok({ hits: [{ id: '1', tenantId: 'acme', title: 'hi', _pk: 'x', _rankingScore: 0.9 }], estimatedTotalHits: 1 }),
    )
    const res = await driver.search('notes', { tenantId: 'acme', q: 'hi', filters: { folder: 'a' } })
    const body = JSON.parse(calls[0]!.body!)
    expect(body.filter).toBe('tenantId = "acme" AND folder = "a"')
    expect(res.hits[0]).toMatchObject({ id: '1', score: 0.9 })
    expect((res.hits[0]!.document as Record<string, unknown>)['_pk']).toBeUndefined() // stripped
  })

  it('removes a document by its compound key', async () => {
    const { calls, driver } = meiliHarness(() => ok({}))
    await driver.remove('notes', 'acme', '1')
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toContain('/indexes/notes/documents/')
  })

  it('rejects a filter field name that could inject filter syntax (tenant-scope escape)', async () => {
    const { calls, driver } = meiliHarness(() => ok({ hits: [], estimatedTotalHits: 0 }))
    await expect(
      // a crafted "field" trying to OR past the mandatory tenantId scope
      driver.search('notes', { tenantId: 'acme', q: 'x', filters: { 'x" OR tenantId = "victim': 1 } }),
    ).rejects.toThrow(/invalid filter field/i)
    expect(calls.length).toBe(0) // never reached the network
  })

  it('rejects an index name that would break out of the REST URL path', async () => {
    const { calls, driver } = meiliHarness(() => ok({}))
    await expect(driver.search('notes/../keys', { tenantId: 'acme', q: 'x' })).rejects.toThrow(/invalid index name/i)
    await expect(driver.register(defineIndex({ name: 'a b', fields: [] }))).rejects.toThrow(/invalid index name/i)
    await expect(driver.remove('a/b', 'acme', '1')).rejects.toThrow(/invalid index name/i)
    expect(calls.length).toBe(0) // never reached the network
  })

  it('accepts a valid index name', async () => {
    const { calls, driver } = meiliHarness(() => ok({}))
    await driver.register(defineIndex({ name: 'my-notes_1', fields: ['title'] }))
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'http://meili.test/indexes' })
  })
})
