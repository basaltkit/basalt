import { describe, expect, it } from 'vitest'
import { Search } from '@basaltkit/search'
import { ElasticsearchDriver, ElasticsearchError, type FetchLike } from '../src/index.js'

/**
 * An Elasticsearch stand-in for the calls a rebuild makes:
 *
 * - `_bulk` stores each document under the `_id` in its action line.
 * - `_delete_by_query` / `_search` evaluate `match_all`, or a `bool.filter` /
 *   bare `term` on exact keyword values (the `tenantId` mapping is `keyword`).
 * - `_delete_by_query` on a missing index answers 404; it can be told to report
 *   `failures` with a 200, as ES does on version conflicts.
 */
function fakeEs(options: { deleteFailures?: unknown[] } = {}) {
  const store = new Map<string, Map<string, Record<string, unknown>>>()
  const reply = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })
  const matches = (query: Record<string, unknown>, doc: Record<string, unknown>): boolean => {
    if ('match_all' in query) return true
    if ('term' in query) {
      const [[field, value]] = Object.entries(query['term'] as Record<string, unknown>) as [[string, unknown]]
      return doc[field] === value
    }
    if ('bool' in query) {
      const bool = query['bool'] as { filter?: Record<string, unknown>[]; must?: unknown[] }
      if (bool.must?.length) throw new Error('fake es: text queries are not modelled')
      return (bool.filter ?? []).every((clause) => matches(clause, doc))
    }
    throw new Error(`fake es: unsupported query ${JSON.stringify(query)}`)
  }

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const segments = new URL(url).pathname.split('/').slice(1).map((s) => decodeURIComponent(s))
    const body = init?.body && !segments.includes('_bulk') ? JSON.parse(init.body) : undefined

    if (method === 'POST' && segments[0] === '_bulk') {
      const lines = String(init?.body).trimEnd().split('\n')
      for (let i = 0; i < lines.length; i += 2) {
        const action = JSON.parse(lines[i]!).index as { _index: string; _id: string }
        let docs = store.get(action._index)
        if (!docs) store.set(action._index, (docs = new Map()))
        docs.set(action._id, JSON.parse(lines[i + 1]!))
      }
      return reply(200, { errors: false })
    }
    const docs = store.get(segments[0]!)
    if (segments[1] === '_delete_by_query') {
      if (!docs) return reply(404, { error: { type: 'index_not_found_exception' } })
      if (options.deleteFailures) return reply(200, { deleted: 0, failures: options.deleteFailures })
      let deleted = 0
      for (const [id, doc] of docs) if (matches(body.query, doc)) deleted += Number(docs.delete(id))
      return reply(200, { deleted, failures: [] })
    }
    if (segments[1] === '_search') {
      const hits = [...(docs?.values() ?? [])].filter((doc) => matches(body.query, doc))
      const from = body.from ?? 0
      const size = body.size ?? 10
      return reply(200, {
        hits: { total: { value: hits.length }, hits: hits.slice(from, from + size).map((doc) => ({ _score: 1, _source: doc })) },
      })
    }
    return reply(400, { error: `fake es: no route ${method} ${url}` })
  }
  return { fetch, count: (index: string) => store.get(index)?.size ?? 0 }
}

const count = async (driver: ElasticsearchDriver, tenantId: string) => (await driver.search('docs', { tenantId, q: '' })).total

describe('ElasticsearchDriver.clearTenant', () => {
  it('deletes by a tenantId term, leaving other tenants', async () => {
    const es = fakeEs()
    const driver = new ElasticsearchDriver({ node: 'http://es.test:9200', fetch: es.fetch })
    await driver.bulk('docs', [
      { id: '1', tenantId: 'acme', title: 'a' },
      { id: '1', tenantId: 'globex', title: 'g' },
    ])
    await driver.clearTenant('docs', 'acme')
    expect(await count(driver, 'acme')).toBe(0)
    expect(await count(driver, 'globex')).toBe(1)
    // A missing index has nothing to delete.
    await expect(driver.clearTenant('nothing', 'acme')).resolves.toBeUndefined()
  })

  it('a _delete_by_query that reports failures is an error, not a half-cleared success', async () => {
    const driver = new ElasticsearchDriver({
      node: 'http://es.test:9200',
      fetch: fakeEs({ deleteFailures: [{ cause: { type: 'version_conflict_engine_exception' } }] }).fetch,
    })
    await driver.bulk('docs', [{ id: '1', tenantId: 'acme', title: 'a' }])
    await expect(driver.clearTenant('docs', 'acme')).rejects.toBeInstanceOf(ElasticsearchError)
    await expect(driver.clear('docs')).rejects.toThrow(/failure/)
  })

  it('a per-tenant reindex keeps every other tenant', async () => {
    const driver = new ElasticsearchDriver({ node: 'http://es.test:9200', fetch: fakeEs().fetch })
    const databases: Record<string, Array<{ id: string; title: string }>> = {
      acme: [
        { id: '1', title: 'acme one' },
        { id: '2', title: 'acme two' },
      ],
      globex: [{ id: '1', title: 'globex one' }],
    }
    let active = ''
    const search = new Search(
      {
        driver,
        rules: [
          {
            index: 'docs',
            document: (row: never) => row,
            async *backfill() {
              yield databases[active]!.map((row) => ({ ...row, tenantId: active })) as never[]
            },
          },
        ] as never,
      },
      () => true,
    )

    for (const tenant of ['acme', 'globex']) {
      active = tenant
      await search.reindex('docs', { tenantId: tenant })
    }

    expect(await count(driver, 'acme')).toBe(2)
    expect(await count(driver, 'globex')).toBe(1)
  })
})
