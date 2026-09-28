import { describe, expect, it } from 'vitest'
import { ElasticsearchDriver, type FetchLike } from '../src/index.js'

/**
 * A stand-in for the Elasticsearch REST layer, faithful where FA-061 lives:
 *
 * - The URL path is split on `/` first and each segment is then percent-decoded
 *   (ES `RestUtils.decodeComponent`), so `%2F` inside an id is part of the id
 *   and `acme%3Aa` addresses `_id` `acme:a`.
 * - A `_bulk` body is JSON: its `_id` is taken literally — nothing is decoded.
 * - `DELETE` of a missing `_id` answers 404.
 *
 * The old driver's own test compared the two ids after decoding BOTH, which is
 * exactly the step ES skips for the bulk body — so it passed while every
 * `remove()` of a bulk-indexed id with a special character missed.
 */
function fakeEs() {
  const store = new Map<string, Map<string, unknown>>()
  const index = (name: string) => {
    let docs = store.get(name)
    if (!docs) store.set(name, (docs = new Map()))
    return docs
  }
  const reply = (status: number, body: unknown = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })

  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const rawPath = new URL(url).pathname
    const segments = rawPath.split('/').slice(1).map((s) => decodeURIComponent(s))

    if (method === 'POST' && segments[0] === '_bulk') {
      const lines = String(init?.body).trimEnd().split('\n')
      for (let i = 0; i < lines.length; i += 2) {
        const action = JSON.parse(lines[i]!).index as { _index: string; _id: string }
        index(action._index).set(action._id, JSON.parse(lines[i + 1]!))
      }
      return reply(200, { errors: false })
    }
    if (segments[1] === '_doc' && segments.length === 3) {
      const [name, , id] = segments as [string, string, string]
      if (method === 'PUT') {
        index(name).set(id, JSON.parse(String(init?.body)))
        return reply(201)
      }
      if (method === 'DELETE') return reply(index(name).delete(id) ? 200 : 404, { result: 'not_found' })
    }
    return reply(200)
  }
  return { fetch, ids: (name: string) => [...index(name).keys()] }
}

const doc = (tenantId: string, id: string) => ({ tenantId, id, title: 't' })
const SPECIAL = ['a b/c', 'x%41', 'q?y#z', 'ümlaut', 'plus+sign', 'semi;colon:x']

describe('FA-061 · Elasticsearch ids agree between the URL path and the bulk body', () => {
  it('remove() deletes a document written by bulk(), whatever its id', async () => {
    const es = fakeEs()
    const driver = new ElasticsearchDriver({ node: 'http://es.test:9200', fetch: es.fetch })

    await driver.bulk('posts', SPECIAL.map((id) => doc('acme', id)) as never)
    expect(es.ids('posts')).toHaveLength(SPECIAL.length)

    for (const id of SPECIAL) await driver.remove('posts', 'acme', id)
    // Old code: the path id was decoded by ES and matched nothing — every
    // deleted document stayed searchable.
    expect(es.ids('posts')).toEqual([])
  })

  it('index() and bulk() of the same document land on ONE _id (an upsert, not a duplicate)', async () => {
    const es = fakeEs()
    const driver = new ElasticsearchDriver({ node: 'http://es.test:9200', fetch: es.fetch })

    for (const id of SPECIAL) {
      await driver.index('posts', doc('acme', id) as never)
      await driver.bulk('posts', [doc('acme', id)] as never)
    }
    expect(es.ids('posts')).toHaveLength(SPECIAL.length)

    for (const id of SPECIAL) await driver.remove('posts', 'acme', id)
    expect(es.ids('posts')).toEqual([])
  })

  it('tenant `a:b` + id `c` and tenant `a` + id `b:c` stay two documents through the path too', async () => {
    const es = fakeEs()
    const driver = new ElasticsearchDriver({ node: 'http://es.test:9200', fetch: es.fetch })
    await driver.index('posts', doc('a:b', 'c') as never)
    await driver.index('posts', doc('a', 'b:c') as never)
    expect(es.ids('posts')).toHaveLength(2)
  })
})
