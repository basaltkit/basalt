import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  MeilisearchDriver,
  MemorySearchDriver,
  Search,
  SearchDriverCapabilityError,
  SearchPaginationError,
  SearchReindexScopeError,
  SearchTenantMismatchError,
  defineIndex,
  type SearchDriver,
} from '../src/index.js'

/**
 * A tenant-scoped rebuild. `reindex()` used to clear the WHOLE index before
 * writing, so the pattern the multi-tenant guide teaches —
 * `tenancy.run(id, () => search.reindex(name))` over a database-per-tenant
 * backfill — left only the last tenant searchable. It now clears and rewrites
 * only the tenant it runs for, on every driver.
 */

const docs = defineIndex({ name: 'docs', fields: ['title'], filterable: ['status'] })

const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithContext({ tenant: { id } } as never, async () => fn())
/**
 * Database-per-tenant: each tenant's rows live in their own database, and the
 * backfill reads whichever database the context tenant selects — exactly what
 * `db()` does inside `tenancy.run`. Every row maps its own tenantId.
 */
function perTenantRule(databases: Record<string, Array<{ id: string; title: string }>>, tenant: () => string | undefined) {
  return {
    index: 'docs',
    document: (row: never) => row as unknown as { id: string },
    async *backfill() {
      const id = tenant()
      if (!id) throw new Error('backfill outside a tenant context')
      yield databases[id]!.map((row) => ({ ...row, tenantId: id })) as never[]
    },
  }
}

/** A shared table: the backfill yields every tenant's rows wherever it runs. */
function sharedRule(rows: Array<{ id: string; title: string; tenantId: string }>) {
  return {
    index: 'docs',
    document: (row: never) => row as unknown as { id: string },
    async *backfill() {
      yield rows as never[]
    },
  }
}

// ── A Meilisearch stand-in, faithful to the parts a rebuild touches ──────────
//
// - Documents are keyed by the index's primary key (`_pk`); `PUT documents`
//   upserts by it.
// - `DELETE /documents` deletes every document; `POST /documents/delete` with a
//   `filter` deletes the matches, and refuses a filter on an attribute that is
//   not in `filterableAttributes` (`invalid_document_filter`).
// - Writes are enqueued tasks processed in order per index — applied here in
//   arrival order, which is the observable result of that queue.
// - A search applies the `tenantId = "…"` part of the filter.
function fakeMeili() {
  const indexes = new Map<string, { filterable: string[]; docs: Map<string, Record<string, unknown>> }>()
  const get = (uid: string) => {
    let index = indexes.get(uid)
    if (!index) indexes.set(uid, (index = { filterable: [], docs: new Map() }))
    return index
  }
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const task = () => reply(202, { taskUid: 1, status: 'enqueued' })
  const matches = (filter: string, filterable: string[], doc: Record<string, unknown>): boolean =>
    filter.split(' AND ').every((clause) => {
      const m = /^([A-Za-z_.]+) = (.+)$/.exec(clause)
      if (!m) throw new Error(`fake meili: unsupported filter ${clause}`)
      if (!filterable.includes(m[1]!)) throw Object.assign(new Error('invalid_document_filter'), { attr: m[1] })
      return doc[m[1]!] === JSON.parse(m[2]!)
    })

  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const path = new URL(url).pathname.split('/').slice(1)
    const body = init?.body ? JSON.parse(init.body) : undefined
    if (method === 'POST' && path.length === 1) {
      get(body.uid)
      return task()
    }
    const index = get(path[1]!)
    const tail = path.slice(2).join('/')
    if (method === 'PATCH' && tail === 'settings') {
      index.filterable = body.filterableAttributes
      return task()
    }
    if (method === 'PUT' && tail === 'documents') {
      for (const doc of body) index.docs.set(doc._pk, doc)
      return task()
    }
    if (method === 'DELETE' && tail === 'documents') {
      index.docs.clear()
      return task()
    }
    if (method === 'POST' && tail === 'documents/delete') {
      try {
        for (const [pk, doc] of index.docs) if (matches(body.filter, index.filterable, doc)) index.docs.delete(pk)
      } catch (error) {
        return reply(400, { message: String((error as Error).message), code: 'invalid_document_filter' })
      }
      return task()
    }
    if (method === 'POST' && tail === 'search') {
      const hits = [...index.docs.values()].filter((doc) => matches(body.filter, index.filterable, doc))
      return reply(200, { hits: hits.slice(body.offset, body.offset + body.limit), estimatedTotalHits: hits.length })
    }
    return reply(404, { message: `fake meili: no route ${method} ${url}` })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, count: (uid: string) => get(uid).docs.size }
}

const drivers: Array<[string, () => Promise<SearchDriver>]> = [
  ['MemorySearchDriver', async () => new MemorySearchDriver()],
  [
    'MeilisearchDriver',
    async () => {
      const driver = new MeilisearchDriver({ host: 'http://meili.test', fetch: fakeMeili().fetch })
      await driver.register(docs)
      return driver
    },
  ],
]

describe.each(drivers)('%s · a per-tenant reindex keeps every other tenant', (_name, make) => {
  const databases = {
    acme: [
      { id: 'a1', title: 'acme report' },
      { id: 'a2', title: 'acme memo' },
    ],
    globex: [{ id: 'g1', title: 'globex report' }],
  }

  const count = async (driver: SearchDriver, tenantId: string) => (await driver.search('docs', { tenantId, q: '' })).total

  it('tenancy.run(id, () => reindex()) for each tenant leaves every tenant searchable', async () => {
    const driver = await make()
    await driver.register?.(docs)
    let active: string | undefined
    const search = new Search({ driver, rules: [perTenantRule(databases, () => active)] as never }, () => true)
    const run = async <T>(id: string, fn: () => Promise<T>) => {
      active = id
      try {
        return await inTenant(id, fn)
      } finally {
        active = undefined
      }
    }

    expect(await run('acme', () => search.reindex('docs'))).toBe(2)
    expect(await run('globex', () => search.reindex('docs'))).toBe(1)

    // Old code: the second call cleared the index, so acme had 0 here.
    expect(await count(driver, 'acme')).toBe(2)
    expect(await count(driver, 'globex')).toBe(1)
  })

  it('a scoped rebuild still clears its own tenant: a deleted record disappears', async () => {
    const driver = await make()
    await driver.register?.(docs)
    await driver.bulk('docs', [
      { id: 'stale', tenantId: 'acme', title: 'deleted since' },
      { id: 'g1', tenantId: 'globex', title: 'globex report' },
    ])
    const search = new Search(
      { driver, rules: [sharedRule([{ id: 'a1', tenantId: 'acme', title: 'acme report' }])] as never },
      () => true,
    )

    expect(await search.reindex('docs', { tenantId: 'acme' })).toBe(1)
    const acme = await driver.search('docs', { tenantId: 'acme', q: '' })
    expect(acme.hits.map((hit) => hit.id)).toEqual(['a1'])
    expect(await count(driver, 'globex')).toBe(1)
  })

  it('over a shared table, a scoped rebuild writes only its tenant\'s rows', async () => {
    const driver = await make()
    await driver.register?.(docs)
    await driver.bulk('docs', [{ id: 'g-old', tenantId: 'globex', title: 'globex original' }])
    const search = new Search(
      {
        driver,
        rules: [
          sharedRule([
            { id: 'a1', tenantId: 'acme', title: 'acme report' },
            { id: 'g-new', tenantId: 'globex', title: 'globex newer' },
          ]),
        ] as never,
      },
      () => true,
    )

    expect(await inTenant('acme', () => search.reindex('docs'))).toBe(1)
    // globex was neither cleared nor written.
    const globex = await driver.search('docs', { tenantId: 'globex', q: '' })
    expect(globex.hits.map((hit) => hit.id)).toEqual(['g-old'])
  })
})

describe('reindex() scope is never guessed', () => {
  const rows = [
    { id: 'a1', tenantId: 'acme', title: 'acme report' },
    { id: 'g1', tenantId: 'globex', title: 'globex report' },
  ]

  it('with tenancy on and no context, a bare reindex() is refused before anything is read or cleared', async () => {
    const driver = new MemorySearchDriver()
    await driver.bulk('docs', [{ id: 'keep', tenantId: 'acme', title: 'keep' }])
    let reads = 0
    const search = new Search(
      {
        driver,
        rules: [{ index: 'docs', document: (row: never) => row, async *backfill() { reads++; yield rows as never[] } }] as never,
      },
      () => true,
    )

    await expect(search.reindex('docs')).rejects.toBeInstanceOf(SearchReindexScopeError)
    expect(reads).toBe(0)
    expect((await driver.search('docs', { tenantId: 'acme', q: '' })).total).toBe(1)
    // Explicit whole-index rebuild is still there.
    expect(await search.reindex('docs', { all: true })).toBe(2)
  })

  it('refuses { all: true } inside a tenant context, and a tenantId that is not the context tenant', async () => {
    const search = new Search({ driver: new MemorySearchDriver(), rules: [sharedRule(rows)] as never }, () => true)
    await expect(inTenant('acme', () => search.reindex('docs', { all: true }))).rejects.toBeInstanceOf(SearchReindexScopeError)
    await expect(inTenant('acme', () => search.reindex('docs', { tenantId: 'globex' }))).rejects.toBeInstanceOf(
      SearchTenantMismatchError,
    )
    await expect(search.reindex('docs', { all: true, tenantId: 'acme' })).rejects.toBeInstanceOf(SearchReindexScopeError)
    expect(await inTenant('acme', () => search.reindex('docs', { tenantId: 'acme' }))).toBe(1)
  })

  it('a single-tenant app still rebuilds its whole index with a bare reindex()', async () => {
    const driver = new MemorySearchDriver()
    await driver.bulk('docs', [{ id: 'stale', tenantId: '@single', title: 'gone' }])
    const search = new Search({
      driver,
      rules: [{ index: 'docs', document: (row: never) => row, async *backfill() { yield [{ id: 'x', title: 'x' }] as never[] } }] as never,
    })
    expect(await search.reindex('docs')).toBe(1)
    expect((await search.search('docs', '')).hits.map((hit) => hit.id)).toEqual(['x'])
  })
})

describe('a custom driver without clearTenant fails closed', () => {
  function legacyDriver() {
    const inner = new MemorySearchDriver()
    let clears = 0
    const driver: SearchDriver = {
      index: (name, document) => inner.index(name, document),
      bulk: (name, documents) => inner.bulk(name, documents),
      remove: (name, tenantId, id) => inner.remove(name, tenantId, id),
      search: (name, query) => inner.search(name, query),
      async clear(name) {
        clears++
        await inner.clear(name)
      },
    }
    return { driver, inner, clears: () => clears }
  }

  it('refuses a scoped rebuild instead of clearing every tenant', async () => {
    const { driver, inner, clears } = legacyDriver()
    await inner.bulk('docs', [{ id: 'g1', tenantId: 'globex', title: 'globex report' }])
    let reads = 0
    const search = new Search(
      {
        driver,
        rules: [
          {
            index: 'docs',
            document: (row: never) => row,
            async *backfill() {
              reads++
              yield [{ id: 'a1', tenantId: 'acme', title: 'acme' }] as never[]
            },
          },
        ] as never,
      },
      () => true,
    )

    await expect(inTenant('acme', () => search.reindex('docs'))).rejects.toBeInstanceOf(SearchDriverCapabilityError)
    await expect(search.reindex('docs', { tenantId: 'acme' })).rejects.toThrow(/clearTenant/)
    expect(clears()).toBe(0)
    expect(reads).toBe(0)
    expect((await inner.search('docs', { tenantId: 'globex', q: '' })).total).toBe(1)

    // The whole-index rebuild needs only `clear`, and still works.
    expect(await search.reindex('docs', { all: true })).toBe(1)
    expect(clears()).toBe(1)
  })
})

describe('offset and the authorize scan are bounded', () => {
  function countingDriver(rows: number) {
    const inner = new MemorySearchDriver()
    const documents = Array.from({ length: rows }, (_, i) => ({ id: String(i), tenantId: '@single', title: 'row' }))
    let scanned = 0
    const driver: SearchDriver = {
      index: (name, document) => inner.index(name, document),
      bulk: (name, docs) => inner.bulk(name, docs),
      remove: (name, tenantId, id) => inner.remove(name, tenantId, id),
      clear: (name) => inner.clear(name),
      async search(name, query) {
        const result = await inner.search(name, query)
        scanned += result.hits.length
        return result
      },
    }
    return { driver, ready: inner.bulk('docs', documents), scanned: () => scanned }
  }

  it('an offset above maxOffset (default 10000) is a 400, and the limit is configurable', async () => {
    const search = new Search()
    await expect(search.search('docs', '', { offset: 10_001 })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', '', { offset: 10_000 })).resolves.toMatchObject({ total: 0 })

    const tight = new Search({ maxOffset: 100 })
    await expect(tight.search('docs', '', { offset: 101 })).rejects.toThrow(/offset 101 exceeds the maximum of 100/)
    expect(() => new Search({ maxOffset: 0 })).toThrow(/maxOffset/)
  })

  it('an authorized search that finds nothing stops at the maxScan ceiling', async () => {
    const { driver, ready, scanned } = countingDriver(3_000)
    await ready
    const search = new Search({ driver, maxScan: 500 })
    // Without the ceiling the default budget is (offset + limit) * 20 = 44 000 rows.
    const result = await search.search('docs', '', { offset: 1_200, limit: 1_000, authorize: () => [] })
    expect(scanned()).toBe(500)
    expect(result).toMatchObject({ hits: [], total: 0, totalExact: false })
  })

  it('a per-call maxScan may lower the ceiling but not raise it', async () => {
    const search = new Search({ maxScan: 500 })
    await expect(search.search('docs', '', { authorize: (h) => h, maxScan: 501 })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', '', { authorize: (h) => h, maxScan: 0 })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', '', { authorize: (h) => h, maxScan: 200 })).resolves.toMatchObject({ totalExact: true })
  })
})
