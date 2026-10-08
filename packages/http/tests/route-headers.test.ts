import { Container } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { assertRouteMetaValid, InvalidRouteMetaError, route, runRoute } from '../src/index.js'
import { routeHeadersProblems } from '../src/route-headers.js'
import { FakeReply, makeRequest } from './support.js'

const withHeaders = (headers: unknown) => route({ method: 'GET', url: '/r', meta: { headers }, handler: () => 'ok' })

describe('BK-085 — meta.headers', () => {
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
  ])('refuses %j', (headers, problem) => {
    expect(routeHeadersProblems(withHeaders(headers)).join()).toContain(problem)
  })

  it('is checked at boot by assertRouteMetaValid even with no plugin validator registered', () => {
    expect(() => assertRouteMetaValid([withHeaders({ 'X-A': 'a\r\nb' })], new Container())).toThrow(InvalidRouteMetaError)
    expect(() => assertRouteMetaValid([withHeaders({ 'X-A': 'ok' })], new Container())).not.toThrow()
  })

  it('a bespoke runRoute driver that skipped the boot check fails the request, never sends the header', async () => {
    const reply = new FakeReply()
    await expect(runRoute(withHeaders({ 'X-A': 'a\r\nb' }), makeRequest(), reply)).rejects.toThrow(/control character/)
    expect(reply.headers['x-a']).toBeUndefined()
  })

  it('sets the headers before the handler runs', async () => {
    const reply = new FakeReply()
    let seen: string | undefined
    const def = route({
      method: 'GET',
      url: '/r',
      meta: { headers: { 'X-Robots-Tag': 'noindex' } },
      handler: ({ reply: r }) => {
        seen = (r as FakeReply).headers['x-robots-tag']
        return 'ok'
      },
    })
    await runRoute(def, makeRequest(), reply)
    expect(seen).toBe('noindex')
  })
})
