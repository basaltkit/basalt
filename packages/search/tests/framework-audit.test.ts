import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  MeilisearchDriver,
  MemorySearchDriver,
  Search,
  SearchFilterNotFilterableError,
  SearchFilterValueError,
  SearchPaginationError,
  TenantRequiredError,
  defineIndex,
} from '../src/index.js'

const docs = defineIndex({ name: 'docs', fields: ['title'], filterable: ['status'] })

const inTenant = <T>(id: string, fn: () => Promise<T>) => runWithContext({ tenant: { id } } as never, async () => fn())

const rule = (rows: Array<{ id: string; title: string; tenantId?: string }>) => ({
  index: 'docs',
  document: (row: never) => row as unknown as { id: string },
  async *backfill() {
    yield rows as never[]
  },
})

describe('FA-050 · reindex() never guesses a tenant, and validates before it clears', () => {
  it('refuses tenant-less rows when started from inside a tenant — they are not filed under that tenant', async () => {
    const driver = new MemorySearchDriver()
    await driver.register(docs)
    const search = new Search(
      { driver, rules: [rule([{ id: 'a', title: 'alpha report' }, { id: 'b', title: 'beta report' }])] as never },
      () => true,
    )

    await expect(inTenant('acme', () => search.reindex('docs'))).rejects.toBeInstanceOf(TenantRequiredError)
    expect((await driver.search('docs', { tenantId: 'acme', q: 'report' })).total).toBe(0)
  })

  it('with tenancy on and no context, the existing index survives the refusal', async () => {
    const driver = new MemorySearchDriver()
    await driver.register(docs)
    const search = new Search({ driver, rules: [rule([{ id: 'a', title: 'alpha' }])] as never }, () => true)
    await inTenant('acme', () => search.index('docs', { id: 'keep', title: 'keep me' }))

    await expect(search.reindex('docs')).rejects.toBeInstanceOf(TenantRequiredError)
    // Old code cleared first and threw second: the index was empty here.
    expect((await driver.search('docs', { tenantId: 'acme', q: 'keep' })).total).toBe(1)
  })

  it('a bad row late in the stream still fails before anything is cleared', async () => {
    const driver = new MemorySearchDriver()
    await driver.register(docs)
    const search = new Search(
      {
        driver,
        rules: [
          {
            index: 'docs',
            document: (row: never) => row as unknown as { id: string },
            async *backfill() {
              yield [{ id: 'a', tenantId: 'acme', title: 'fine' }] as never[]
              yield [{ id: 'b', tenantId: '@single', title: 'reserved' }] as never[]
            },
          },
        ] as never,
      },
      () => true,
    )
    await inTenant('acme', () => search.index('docs', { id: 'keep', title: 'keep me' }))

    await expect(search.reindex('docs')).rejects.toThrow()
    expect((await driver.search('docs', { tenantId: 'acme', q: 'keep' })).total).toBe(1)
  })

  it('rows that carry their tenant are rebuilt from any context, and single-tenant apps still work', async () => {
    const driver = new MemorySearchDriver()
    await driver.register(docs)
    const multi = new Search(
      {
        driver,
        rules: [rule([{ id: 'a', tenantId: 'acme', title: 'alpha' }, { id: 'b', tenantId: 'globex', title: 'beta' }])] as never,
      },
      () => true,
    )
    expect(await inTenant('acme', () => multi.reindex('docs'))).toBe(2)
    expect((await driver.search('docs', { tenantId: 'globex', q: 'beta' })).total).toBe(1)

    const single = new Search({ driver: new MemorySearchDriver(), rules: [rule([{ id: 'a', title: 'alpha' }])] as never })
    expect(await single.reindex('docs')).toBe(1)
    expect((await single.search('docs', 'alpha')).total).toBe(1)
  })
})

describe('FA-066 · pagination is validated and bounded', () => {
  async function setup(maxLimit?: number) {
    const driver = new MemorySearchDriver()
    await driver.register(docs)
    await driver.bulk(
      'docs',
      Array.from({ length: 5 }, (_, i) => ({ id: String(i), tenantId: '@single', title: 'row' })),
    )
    return new Search({ driver, indexes: [docs], ...(maxLimit !== undefined ? { maxLimit } : {}) })
  }

  it('rejects negative, fractional and non-numeric limit/offset', async () => {
    const search = await setup()
    // Old code: limit -1 reached the memory driver as slice(0, -1) — four rows.
    await expect(search.search('docs', 'row', { limit: -1 })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', 'row', { limit: 1.5 })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', 'row', { offset: -2 })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', 'row', { limit: '10' as never })).rejects.toBeInstanceOf(SearchPaginationError)
    await expect(search.search('docs', 'row', { limit: -1, authorize: (h) => h })).rejects.toBeInstanceOf(
      SearchPaginationError,
    )
  })

  it('caps limit at maxLimit (default 1000)', async () => {
    await expect((await setup()).search('docs', 'row', { limit: 1_000_000 })).rejects.toBeInstanceOf(
      SearchPaginationError,
    )
    const small = await setup(2)
    await expect(small.search('docs', 'row', { limit: 3 })).rejects.toBeInstanceOf(SearchPaginationError)
    expect((await small.search('docs', 'row', { limit: 2 })).hits).toHaveLength(2)
    expect((await small.search('docs', 'row', { limit: 0 })).total).toBe(5)
  })
})

describe('FA-066 · filters are restricted to declared fields and scalar values', () => {
  async function setup() {
    const driver = new MemorySearchDriver()
    await driver.register(docs)
    await driver.bulk('docs', [
      { id: '1', tenantId: '@single', title: 'row', status: 'open', salary: 90000 },
      { id: '2', tenantId: '@single', title: 'row', status: 'closed', salary: 10 },
    ])
    return new Search({ driver, indexes: [docs] })
  }

  it('a field not declared filterable is refused (no probing of stored fields)', async () => {
    const search = await setup()
    // Old code: this answered "does anyone earn 90000?" through a field the
    // index never declared filterable.
    await expect(search.search('docs', 'row', { filters: { salary: 90000 } })).rejects.toBeInstanceOf(
      SearchFilterNotFilterableError,
    )
    expect((await search.search('docs', 'row', { filters: { status: 'open' } })).total).toBe(1)
    expect((await search.search('docs', 'row', { filters: { status: ['open', 'closed'] } })).total).toBe(2)
  })

  it('non-scalar and missing values are refused, not silently widened or stringified', async () => {
    const search = await setup()
    for (const value of [{ $ne: 'x' }, null, undefined, [['open']], [{}], Number.NaN]) {
      await expect(search.search('docs', 'row', { filters: { status: value } })).rejects.toBeInstanceOf(
        SearchFilterValueError,
      )
    }
  })

  it('an index Search was not told about keeps its old, unvalidated field list', async () => {
    const driver = new MemorySearchDriver()
    await driver.bulk('free', [{ id: '1', tenantId: '@single', title: 'row', kind: 'a' }])
    const search = new Search({ driver })
    expect((await search.search('free', 'row', { filters: { kind: 'a' } })).total).toBe(1)
  })

  it('MeilisearchDriver refuses a non-scalar value instead of splicing JSON into the filter DSL', async () => {
    const calls: string[] = []
    const driver = new MeilisearchDriver({
      host: 'http://meili.test',
      fetch: (async (_url: unknown, init?: { body?: unknown }) => {
        calls.push(String(init?.body))
        return new Response('{"hits":[]}', { status: 200 })
      }) as typeof fetch,
    })
    await expect(
      driver.search('docs', { tenantId: 'acme', q: 'x', filters: { status: { a: 1 } } }),
    ).rejects.toBeInstanceOf(SearchFilterValueError)
    await expect(
      driver.search('docs', { tenantId: 'acme', q: 'x', filters: { status: [null] } }),
    ).rejects.toBeInstanceOf(SearchFilterValueError)
    expect(calls).toHaveLength(0)
    await driver.search('docs', { tenantId: 'acme', q: 'x', filters: { status: ['a', 2, true] } })
    expect(JSON.parse(calls[0]!).filter).toBe('tenantId = "acme" AND status IN ["a", 2, true]')
  })
})

describe('FA-066 · searchPlugin forwards its indexes and maxLimit', () => {
  it('a plugin-built Search enforces the declared filterable fields and the limit cap', async () => {
    const { createApp } = await import('@basaltkit/core')
    const { SEARCH, searchPlugin } = await import('../src/index.js')
    const app = await createApp({ plugins: [searchPlugin({ indexes: [docs], maxLimit: 5 })] }).boot()
    const search = app.container.get(SEARCH)
    await expect(search.search('docs', 'x', { filters: { salary: 1 } })).rejects.toBeInstanceOf(
      SearchFilterNotFilterableError,
    )
    await expect(search.search('docs', 'x', { limit: 6 })).rejects.toBeInstanceOf(SearchPaginationError)
    expect((await search.search('docs', 'x', { filters: { status: 'open' }, limit: 5 })).total).toBe(0)
    await app.shutdown()
  })
})
