import { describe, expect, it } from 'vitest'
import { checkRequest, CLIENT_FILE, type RequestFacts } from '../src/security.js'
import { IdleTimer, LAUNCH_TTL_MS, safeEqual, Session } from '../src/session.js'

const PORT = 45123
const api = (headers: Record<string, string | undefined> = {}, method = 'POST', url = '/api/status'): RequestFacts => ({
  method, url,
  headers: { host: `127.0.0.1:${PORT}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${PORT}`, ...headers },
})

describe('checkRequest', () => {
  it('routes the page, its stylesheet, its modules and the API', () => {
    expect(checkRequest({ method: 'GET', url: '/', headers: { host: `127.0.0.1:${PORT}` } }, PORT)).toEqual({ kind: 'static', file: 'index' })
    expect(checkRequest({ method: 'HEAD', url: '/app.css', headers: { host: `127.0.0.1:${PORT}` } }, PORT)).toEqual({ kind: 'static', file: 'css' })
    expect(checkRequest({ method: 'GET', url: '/client/view-run.js', headers: { host: `127.0.0.1:${PORT}` } }, PORT)).toEqual({ kind: 'static', file: { client: 'view-run.js' } })
    expect(checkRequest(api(), PORT)).toEqual({ kind: 'api', route: 'status' })
    expect(checkRequest(api({ 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' }), PORT)).toEqual({ kind: 'api', route: 'status' })
  })

  it('421 for any Host but 127.0.0.1:<port> (DNS rebinding)', () => {
    for (const host of [undefined, 'attacker.example', `attacker.example:${PORT}`, `localhost:${PORT}`, `127.0.0.1:${PORT + 1}`, '127.0.0.1', `[::1]:${PORT}`, `127.0.0.1:${PORT}.attacker.example`]) {
      expect(checkRequest(api({ host }), PORT), String(host)).toMatchObject({ kind: 'refuse', status: 421 })
    }
    expect(checkRequest({ method: 'GET', url: '/', headers: { host: [`127.0.0.1:${PORT}`, 'x'] } }, PORT)).toMatchObject({ status: 421 })
  })

  it('no path from the request reaches anything: traversal, encoding, queries, absolute forms', () => {
    for (const url of ['/client/../bin.js', '/client/%2e%2e/bin.js', '/client/..%2fbin.js', '/client/./main.js', '/client/Main.js', '/client/main.mjs', '/client/sub/x.js', '//x', '/?a=1', 'http://127.0.0.1/', '/client/main.js?v=1', '/server.js', '/api/../x']) {
      const verdict = checkRequest({ method: 'GET', url, headers: { host: `127.0.0.1:${PORT}` } }, PORT)
      expect(verdict.kind, url).toBe('refuse')
    }
    expect(CLIENT_FILE.test('main.js')).toBe(true)
  })

  it('the API: POST only, JSON only, our Origin only, same-origin fetches only — no CORS', () => {
    expect(checkRequest(api({}, 'GET'), PORT)).toMatchObject({ status: 405 })
    expect(checkRequest(api({}, 'OPTIONS'), PORT)).toMatchObject({ status: 405 })
    expect(checkRequest(api({}, 'PUT'), PORT)).toMatchObject({ status: 405 })
    expect(checkRequest({ method: 'POST', url: '/', headers: { host: `127.0.0.1:${PORT}` } }, PORT)).toMatchObject({ status: 405 })
    for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json-patch+json', 'application/jsonx']) {
      expect(checkRequest(api({ 'content-type': type }), PORT), String(type)).toMatchObject({ status: 415 })
    }
    for (const origin of [undefined, 'null', 'https://attacker.example', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT + 1}`, `https://127.0.0.1:${PORT}`]) {
      expect(checkRequest(api({ origin }), PORT), String(origin)).toMatchObject({ status: 403 })
    }
    for (const site of ['cross-site', 'same-site', 'none']) expect(checkRequest(api({ 'sec-fetch-site': site }), PORT), site).toMatchObject({ status: 403 })
  })
})

describe('the session', () => {
  const fixed = (byte: number) => (size: number) => Buffer.alloc(size, byte)

  it('32 random bytes each for the launch code and the token; the first exchange wins, any later one is 409', () => {
    let calls = 0
    const random = (size: number) => { calls++; expect(size).toBe(32); return Buffer.alloc(size, calls) }
    const session = new Session(() => 0, random)
    expect(session.launchCode).toBe(Buffer.alloc(32, 1).toString('base64url'))
    expect(session.exchange('wrong')).toMatchObject({ ok: false, status: 401 })
    expect(session.exchange(undefined)).toMatchObject({ ok: false, status: 401 })
    expect(session.authorizes(`Bearer ${Buffer.alloc(32, 2).toString('base64url')}`)).toBe(false)
    const first = session.exchange(session.launchCode)
    expect(first).toEqual({ ok: true, token: Buffer.alloc(32, 2).toString('base64url') })
    expect(session.exchange(session.launchCode)).toMatchObject({ ok: false, status: 409 })
    expect(session.exchange('wrong')).toMatchObject({ ok: false, status: 409 })
    expect(session.isClaimed).toBe(true)
    const token = (first as { token: string }).token
    expect(session.authorizes(`Bearer ${token}`)).toBe(true)
    for (const header of [undefined, '', token, `Bearer  ${token}`, `Bearer ${token} `, `bearer ${token}`, `Bearer ${token.slice(0, -1)}`, `Bearer ${token}=`]) expect(session.authorizes(header), String(header)).toBe(false)
  })

  it('the launch code expires after 120 s', () => {
    let now = 1000
    const session = new Session(() => now, fixed(7))
    now += LAUNCH_TTL_MS + 1
    expect(session.exchange(session.launchCode)).toMatchObject({ ok: false, status: 401, reason: expect.stringMatching(/expired/) })
  })

  it('compares in constant time, lengths included', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abd', 'abc')).toBe(false)
    expect(safeEqual('ab', 'abc')).toBe(false)
  })
})

describe('the idle timer', () => {
  function fakeTimers() {
    const pending = new Map<number, { callback: () => void; at: number }>()
    let now = 0
    let id = 0
    return {
      timers: { set: (callback: () => void, ms: number) => { pending.set(++id, { callback, at: now + ms }); return id }, clear: (handle: unknown) => { pending.delete(handle as number) } },
      advance(ms: number) {
        now += ms
        for (const [key, timer] of [...pending]) if (timer.at <= now) { pending.delete(key); timer.callback() }
      },
    }
  }

  it('fires after N minutes without a request; a request resets it; an open stream holds it', () => {
    const clock = fakeTimers()
    let fired = 0
    const idle = new IdleTimer(1000, () => { fired++ }, clock.timers)
    clock.advance(900)
    idle.touch()
    clock.advance(900)
    expect(fired).toBe(0)
    idle.streamOpened()
    clock.advance(10_000)
    expect(fired).toBe(0)
    idle.streamClosed()
    clock.advance(999)
    expect(fired).toBe(0)
    clock.advance(1)
    expect(fired).toBe(1)
    idle.stop()
    idle.touch()
    clock.advance(10_000)
    expect(fired).toBe(1)
  })
})
