import { Container } from '@basaltkit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  InvalidRouteHeadersError,
  InvalidRouteMetaError,
  assertRouteMetaValid,
  assertRoutesGuarded,
  route,
  runRoute,
} from '../src/index.js'
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

  it('refuses the boot, through assertRoutesGuarded and assertRouteMetaValid alike, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const routes = [withHeaders({ 'X-A': 'a\r\nb' }), withHeaders({ 'Set-Cookie': 'a=1' })]
    // No plugin validator registered: the built-in check still runs.
    expect(() => assertRouteMetaValid(routes, new Container())).toThrow(InvalidRouteMetaError)
    try {
      assertRoutesGuarded(routes, new Container())
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRouteMetaError)
      expect(error).toMatchObject({ code: 'HTTP_INVALID_ROUTE_META' })
      expect((error as InvalidRouteMetaError).problems).toEqual([
        { route: 'GET /r', problem: 'meta.responseHeaders["X-A"] contains a control character (CR, LF, NUL…)' },
        { route: 'GET /r', problem: 'meta.responseHeaders: "Set-Cookie" cannot be set per route (it is managed by the adapter or the response)' },
      ])
    }
    // A waiver for unclaimed keys never waives a malformed value.
    expect(() => assertRoutesGuarded(routes, new Container(), true)).toThrow(InvalidRouteMetaError)
    expect(warn).not.toHaveBeenCalled()
  })

  it('throws InvalidRouteHeadersError at request time on a record that skipped the boot check', async () => {
    const def = withHeaders({ 'X-A': 'a\r\nb' })
    for (let attempt = 0; attempt < 2; attempt++) {
      // Never cached as valid: every request throws.
      const reply = new FakeReply()
      const running = runRoute(def, makeRequest(), reply)
      await expect(running).rejects.toBeInstanceOf(InvalidRouteHeadersError)
      await expect(running).rejects.toMatchObject({ code: 'HTTP_INVALID_ROUTE_HEADERS', status: 500 })
      expect(reply.headers['x-a']).toBeUndefined()
    }
  })

  it('sets no header of an invalid record, valid siblings included', async () => {
    const reply = new FakeReply()
    await expect(
      runRoute(withHeaders({ 'X-Robots-Tag': 'noindex', 'Set-Cookie': 'a=1' }), makeRequest(), reply),
    ).rejects.toBeInstanceOf(InvalidRouteHeadersError)
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
