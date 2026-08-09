import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
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

  it('throws when no tenant can be determined', async () => {
    const search = new Search({ driver: await seed() })
    await expect(search.search('notes', 'quick')).rejects.toBeInstanceOf(TenantRequiredError)
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
})
