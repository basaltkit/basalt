import { describe, expect, it } from 'vitest'
import { runRoute, route, computeEtag, ifNoneMatchSatisfied, type HttpReply, type HttpRequest } from '../src/index.js'

class Reply implements HttpReply {
  statusCode = 200
  sent = false
  payload: unknown = undefined
  raw: unknown = null
  headers: Record<string, string> = {}
  code(status: number): this { this.statusCode = status; return this }
  header(name: string, value: string): this { this.headers[name.toLowerCase()] = value; return this }
  send(payload?: unknown): unknown { this.sent = true; this.payload = payload; return payload }
}

const req = (o: Partial<HttpRequest> = {}): HttpRequest => ({
  method: 'GET', url: '/x', headers: {}, params: {}, query: undefined, body: undefined, raw: null, ...o,
})

describe('etag helpers', () => {
  it('computeEtag is stable and quoted', () => {
    expect(computeEtag('{"a":1}')).toBe(computeEtag('{"a":1}'))
    expect(computeEtag('{"a":1}')).not.toBe(computeEtag('{"a":2}'))
    expect(computeEtag('x')).toMatch(/^".+"$/)
  })
  it('ifNoneMatchSatisfied handles *, lists and weak tags', () => {
    const tag = '"abc"'
    expect(ifNoneMatchSatisfied('*', tag)).toBe(true)
    expect(ifNoneMatchSatisfied('"abc"', tag)).toBe(true)
    expect(ifNoneMatchSatisfied('W/"abc"', tag)).toBe(true)
    expect(ifNoneMatchSatisfied('"x", "abc"', tag)).toBe(true)
    expect(ifNoneMatchSatisfied('"x"', tag)).toBe(false)
    expect(ifNoneMatchSatisfied(undefined, tag)).toBe(false)
  })
})

describe('runRoute ETag (meta.etag)', () => {
  const data = route({ method: 'GET', url: '/data', meta: { etag: true }, async handler() { return { a: 1 } } })

  it('sets an ETag and returns the body on the first request', async () => {
    const reply = new Reply()
    const value = await runRoute(data, req(), reply)
    expect(reply.headers['etag']).toBeTruthy()
    expect(value).toEqual({ a: 1 })
    expect(reply.statusCode).toBe(200)
  })

  it('returns 304 with no body when If-None-Match matches', async () => {
    const first = new Reply()
    await runRoute(data, req(), first)
    const etag = first.headers['etag']!

    const reply = new Reply()
    const value = await runRoute(data, req({ headers: { 'if-none-match': etag } }), reply)
    expect(reply.statusCode).toBe(304)
    expect(reply.sent).toBe(true)
    expect(value).toBeUndefined()
  })

  it('does nothing without meta.etag, or for non-GET', async () => {
    const plain = route({ method: 'GET', url: '/p', async handler() { return { a: 1 } } })
    const r1 = new Reply()
    await runRoute(plain, req(), r1)
    expect(r1.headers['etag']).toBeUndefined()

    const post = route({ method: 'POST', url: '/data', meta: { etag: true }, async handler() { return { a: 1 } } })
    const r2 = new Reply()
    await runRoute(post, req({ method: 'POST' }), r2)
    expect(r2.headers['etag']).toBeUndefined()
  })
})
