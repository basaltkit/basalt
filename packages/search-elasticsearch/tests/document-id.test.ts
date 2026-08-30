import { describe, expect, it } from 'vitest'
import { ElasticsearchDriver, type FetchLike } from '../src/index.js'

function fakeFetch() {
  const calls: { method: string; path: string; body?: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      path: url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''),
      ...(init?.body ? { body: String(init.body) } : {}),
    })
    return { ok: true, status: 200, text: async () => '{}' }
  }
  return { fetch, calls }
}

const driver = (fetch: FetchLike) => new ElasticsearchDriver({ node: 'http://es.test:9200', apiKey: 'k', fetch })

const doc = (tenantId: string, id: string) => ({ tenantId, id, title: 't' })

describe('Elasticsearch document ids', () => {
  it('index() and bulk() address the SAME _id for the same document', async () => {
    const { fetch, calls } = fakeFetch()
    const es = driver(fetch)

    await es.index('posts', doc('acme', 'a b/c') as never)
    await es.bulk('posts', [doc('acme', 'a b/c') as never])

    const single = decodeURIComponent(calls[0]!.path.split('/_doc/')[1] as string)
    const bulked = decodeURIComponent(JSON.parse(calls[1]!.body!.split('\n')[0] as string).index._id as string)
    expect(bulked).toBe(single)
  })

  it('remove() addresses the id bulk() wrote', async () => {
    const { fetch, calls } = fakeFetch()
    const es = driver(fetch)

    await es.bulk('posts', [doc('acme', 'a b/c') as never])
    await es.remove('posts', 'acme', 'a b/c')

    const bulked = JSON.parse(calls[0]!.body!.split('\n')[0] as string).index._id as string
    expect(calls[1]!.path).toContain(`/_doc/${bulked}`)
  })

  it('F-7 · a `:` in a tenant id cannot collide with another tenant', async () => {
    const { fetch, calls } = fakeFetch()
    const es = driver(fetch)

    // Classic ambiguity: "a:b" + "c"  vs  "a" + "b:c" — same raw `${t}:${id}`.
    await es.bulk('posts', [doc('a:b', 'c') as never])
    await es.bulk('posts', [doc('a', 'b:c') as never])

    const first = JSON.parse(calls[0]!.body!.split('\n')[0] as string).index._id as string
    const second = JSON.parse(calls[1]!.body!.split('\n')[0] as string).index._id as string
    expect(first).not.toBe(second)
  })

  it('leaves plain UUID-shaped ids byte-for-byte unchanged', async () => {
    const { fetch, calls } = fakeFetch()
    await driver(fetch).bulk('posts', [doc('acme', '0f5c2e11-8a1b-4d2e-9d1a-1f2b3c4d5e6f') as never])

    const id = JSON.parse(calls[0]!.body!.split('\n')[0] as string).index._id as string
    expect(id).toBe('acme:0f5c2e11-8a1b-4d2e-9d1a-1f2b3c4d5e6f')
  })
})
