import { Container } from '@basaltkit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertRouteMetaValid, assertRoutesGuarded, route, runRoute } from '../src/index.js'
import { routeHeadersProblems } from '../src/route-headers.js'
import { FakeReply, makeRequest } from './support.js'

const withHeaders = (responseHeaders: unknown) =>
  route({ method: 'GET', url: '/r', meta: { responseHeaders }, handler: () => 'ok' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BK-085 — meta.responseHeaders', () => {
  it('accepts plain string headers', () => {
    expect(routeHeadersProblems(withHeaders({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }))).toEqual([])
    expect(routeHeadersProblems(route({ method: 'GET', url: '/n', handler: () => 'ok' }))).toEqual([])
  })

  it.each([
    [['a'], 'must be an object'],
    [null, 'must be an object'],
    [{ 'Bad Name': 'x' }, 'not a valid header name'],
    [{ 'Set-Cookie': 'a=1' }, 'cannot be set per route'],
    [{ 'content-type': 'text/html' }, 'cannot be set per route'],
    [{ 'Content-Length': '1' }, 'cannot be set per route'],
    [{ 'Transfer-Encoding': 'chunked' }, 'cannot be set per route'],
    [{ 'X-Request-Id': 'x' }, 'cannot be set per route'],
    [{ 'X-A': 1 }, 'must be a string'],
    [{ 'X-A': 'a\nb' }, 'control character'],
    [{ 'X-A': 'a\0b' }, 'control character'],
  ])('reports %j', (headers, problem) => {
    expect(routeHeadersProblems(withHeaders(headers)).join()).toContain(problem)
  })

  it('warns once at boot and never refuses it (refused in the next major)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const container = new Container()
    const routes = [withHeaders({ 'X-A': 'a\r\nb' })]
    expect(() => assertRoutesGuarded(routes, container)).not.toThrow()
    expect(() => assertRoutesGuarded(routes, container)).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('GET /r')
    expect(String(warn.mock.calls[0]?.[0])).toContain('next major')
    // assertRouteMetaValid runs plugin validators only; with none it is a no-op, as before.
    expect(() => assertRouteMetaValid(routes, new Container())).not.toThrow()
  })

  it('does not throw at request time on a record that skipped the boot check', async () => {
    const reply = new FakeReply()
    await expect(runRoute(withHeaders({ 'X-A': 'a\r\nb' }), makeRequest(), reply)).resolves.toBe('ok')
  })

  it('sets no header for a CRLF value', async () => {
    const reply = new FakeReply()
    await runRoute(withHeaders({ 'X-A': 'a\r\nb' }), makeRequest(), reply)
    expect(reply.headers['x-a']).toBeUndefined()
  })

  it('ignores the whole record: a valid sibling header on the same route is not set either', async () => {
    const reply = new FakeReply()
    await runRoute(withHeaders({ 'X-Robots-Tag': 'noindex', 'Set-Cookie': 'a=1' }), makeRequest(), reply)
    expect(reply.headers['x-robots-tag']).toBeUndefined()
    expect(reply.headers['set-cookie']).toBeUndefined()
  })

  it('the old meta.headers name sets nothing (it is app-owned data, never response headers)', async () => {
    const reply = new FakeReply()
    const def = route({ method: 'GET', url: '/old', meta: { headers: { 'x-a': 'b' } }, handler: () => 'ok' })
    await runRoute(def, makeRequest(), reply)
    expect(reply.headers['x-a']).toBeUndefined()
  })

  it('sets the headers before the handler runs', async () => {
    const reply = new FakeReply()
    let seen: string | undefined
    const def = route({
      method: 'GET',
      url: '/r',
      meta: { responseHeaders: { 'X-Robots-Tag': 'noindex' } },
      handler: ({ reply: r }) => {
        seen = (r as FakeReply).headers['x-robots-tag']
        return 'ok'
      },
    })
    await runRoute(def, makeRequest(), reply)
    expect(seen).toBe('noindex')
  })
})
