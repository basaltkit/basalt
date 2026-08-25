import { describe, expect, it } from 'vitest'
import type { IndexDefinition } from '@basaltkit/search'
import { ElasticsearchDriver, ElasticsearchError, assertValidIndexName, type FetchLike } from '../src/index.js'

// Fake fetch: routes by "METHOD pathname" (query stripped), records every call.
function fakeFetch(routes: Record<string, { status: number; body?: string }>) {
  const calls: { method: string; url: string; path: string; headers?: Record<string, string>; body?: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
    calls.push({ method, url, path, ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body ? { body: init.body } : {}) })
    const route = routes[`${method} ${path}`] ?? routes[`${method} *`]
    if (!route) return { ok: false, status: 404, text: async () => 'no route' }
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => route.body ?? '' }
  }
  return { fetch, calls }
}

const NODE = 'http://es.test:9200'
const opts = (fetch: FetchLike) => ({ node: NODE, apiKey: 'k', fetch })
const posts: IndexDefinition = { name: 'posts', fields: ['title', 'body'], filterable: ['status'] }

describe('ElasticsearchDriver.register', () => {
  it('creates the index with text + keyword mappings', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /posts': { status: 200, body: '{"acknowledged":true}' } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.register(posts)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.headers?.Authorization).toBe('ApiKey k')
    const props = JSON.parse(put.body!).mappings.properties
    expect(props.tenantId).toEqual({ type: 'keyword' })
    expect(props.title.type).toBe('text')
    expect(props.title.fields.keyword.type).toBe('keyword')
    expect(props.status).toEqual({ type: 'keyword' })
  })

  it('is idempotent when the index already exists', async () => {
    const { fetch } = fakeFetch({
      'PUT /posts': { status: 400, body: '{"error":{"type":"resource_already_exists_exception"}}' },
    })
    const gw = new ElasticsearchDriver(opts(fetch))
    await expect(gw.register(posts)).resolves.toBeUndefined()
  })
})

describe('ElasticsearchDriver.index / bulk / remove', () => {
  it('indexes under a tenant-compound id', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /posts/_doc/acme:p1': { status: 200 } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.index('posts', { id: 'p1', tenantId: 'acme', title: 'Hello' })
    expect(calls[0]!.path).toBe('/posts/_doc/acme:p1')
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ id: 'p1', tenantId: 'acme', title: 'Hello' })
  })

  it('bulk-indexes as NDJSON with compound ids', async () => {
    const { fetch, calls } = fakeFetch({ 'POST /_bulk': { status: 200, body: '{"errors":false}' } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.bulk('posts', [
      { id: 'p1', tenantId: 'acme', title: 'A' },
      { id: 'p2', tenantId: 'acme', title: 'B' },
    ])
    const c = calls[0]!
    expect(c.headers?.['Content-Type']).toBe('application/x-ndjson')
    const lines = c.body!.trim().split('\n')
    expect(JSON.parse(lines[0]!)).toEqual({ index: { _index: 'posts', _id: 'acme:p1' } })
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: 'p1', title: 'A' })
  })

  it('ignores a 404 on remove', async () => {
    const { fetch } = fakeFetch({ 'DELETE /posts/_doc/acme:gone': { status: 404, body: 'not found' } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await expect(gw.remove('posts', 'acme', 'gone')).resolves.toBeUndefined()
  })
})

describe('ElasticsearchDriver.search', () => {
  const canned = JSON.stringify({
    hits: {
      total: { value: 1 },
      hits: [{ _id: 'acme:p1', _score: 1.23, _source: { id: 'p1', tenantId: 'acme', title: 'Hello world' } }],
    },
  })

  it('scopes by tenant, multi_matches the query, and maps hits', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT /posts': { status: 200 },
      'POST /posts/_search': { status: 200, body: canned },
    })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.register(posts)
    const result = await gw.search('posts', { tenantId: 'acme', q: 'hello', filters: { status: 'published' }, limit: 10 })

    const body = JSON.parse(calls.find((c) => c.path === '/posts/_search')!.body!)
    // tenant scope is always present
    expect(body.query.bool.filter).toContainEqual({ term: { tenantId: 'acme' } })
    // filterable field uses its .keyword sub-field
    expect(body.query.bool.filter).toContainEqual({ term: { status: 'published' } })
    // full-text over the registered fields
    expect(body.query.bool.must[0].multi_match).toMatchObject({ query: 'hello', fields: ['title', 'body'] })
    expect(body.size).toBe(10)
    expect(body.track_total_hits).toBe(true)

    expect(result.total).toBe(1)
    expect(result.hits).toEqual([{ id: 'p1', score: 1.23, document: { id: 'p1', tenantId: 'acme', title: 'Hello world' } }])
  })

  it('an array filter becomes a terms query; searchable filter uses .keyword', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT /posts': { status: 200 },
      'POST /posts/_search': { status: 200, body: canned },
    })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.register(posts)
    await gw.search('posts', { tenantId: 'acme', q: '', filters: { status: ['a', 'b'], title: 'x' } })
    const body = JSON.parse(calls.find((c) => c.path === '/posts/_search')!.body!)
    expect(body.query.bool.filter).toContainEqual({ terms: { status: ['a', 'b'] } })
    expect(body.query.bool.filter).toContainEqual({ term: { 'title.keyword': 'x' } }) // title is searchable → .keyword
    expect(body.query.bool.must).toBeUndefined() // empty q → no must, filter-only
  })

  it('with no configured fields, uses simple_query_string (not the injectable query_string)', async () => {
    const { fetch, calls } = fakeFetch({
      'PUT /notes': { status: 200 },
      'POST /notes/_search': { status: 200, body: canned },
    })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.register({ name: 'notes', fields: [], filterable: [] })
    await gw.search('notes', { tenantId: 'acme', q: 'title:secret OR _index:*' })
    const body = JSON.parse(calls.find((c) => c.path === '/notes/_search')!.body!)
    expect(body.query.bool.must[0].simple_query_string).toMatchObject({ query: 'title:secret OR _index:*' })
    expect(body.query.bool.must[0].query_string).toBeUndefined() // never the full-Lucene variant
  })
})

describe('index-name validation', () => {
  it('rejects an index name that would break out of the URL path', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT *': { status: 200 } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await expect(gw.register({ name: 'posts/_all/_delete', fields: [], filterable: [] })).rejects.toThrow(/invalid index name/i)
    await expect(gw.search('a b', { tenantId: 'acme', q: 'x' })).rejects.toThrow(/invalid index name/i)
    expect(calls.length).toBe(0) // never reached the network
  })

  it('rejects an unsafe indexPrefix at construction', () => {
    expect(() => new ElasticsearchDriver({ node: NODE, indexPrefix: 'bad/prefix' })).toThrow(/invalid index name/i)
  })

  it('accepts a valid index name', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /my-index_1': { status: 200 } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await gw.register({ name: 'my-index_1', fields: [], filterable: [] })
    expect(calls[0]!.path).toBe('/my-index_1')
    expect(assertValidIndexName('a_b-C9')).toBe('a_b-C9')
  })
})

describe('errors', () => {
  it('surfaces a non-2xx response as ElasticsearchError', async () => {
    const { fetch } = fakeFetch({ 'PUT /posts/_doc/acme:p1': { status: 500, body: 'boom' } })
    const gw = new ElasticsearchDriver(opts(fetch))
    await expect(gw.index('posts', { id: 'p1', tenantId: 'acme' })).rejects.toBeInstanceOf(ElasticsearchError)
  })
})

describe('ElasticsearchDriver node normalization', () => {
  it('strips every trailing slash from the node URL', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /posts': { status: 200, body: '{"acknowledged":true}' } })
    const gw = new ElasticsearchDriver({ node: 'http://es.test:9200///', apiKey: 'k', fetch })
    await gw.register(posts)
    expect(calls[0]!.url).toBe('http://es.test:9200/posts')
  })

  it('resolves a pathological trailing-slash run promptly (no ReDoS)', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT *': { status: 200, body: '{"acknowledged":true}' } })
    // A long slash run followed by a non-slash char is the polynomial-ReDoS
    // trigger for /\/+$/; the linear trim returns the string unchanged, fast.
    const node = 'https://x/' + '/'.repeat(100000) + 'a'
    const gw = new ElasticsearchDriver({ node, apiKey: 'k', fetch })
    await gw.register(posts)
    expect(calls[0]!.url).toBe(node + '/posts')
  })
})
