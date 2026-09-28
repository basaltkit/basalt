import { afterEach, describe, expect, it } from 'vitest'
import { route } from '@basaltkit/http'
import { Auth, LoginThrottle, MemoryThrottleStore, MemoryUserSource, authPlugin, signJwt, verifyJwt } from '../src/index.js'
import { availableAdapters, boot, type Harness } from './helpers/adapters.js'

const SECRET = 'a'.repeat(40)
const users = () => new MemoryUserSource()

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe('FA-012 — an unreadable session cookie is anonymous, never a 500', () => {
  it('sessionIdFromCookie() returns null on malformed percent-encoding', () => {
    const auth = new Auth({ users: users(), secret: SECRET })
    expect(auth.sessionIdFromCookie('basalt_session=%E0%A4%A')).toBeNull()
    expect(auth.sessionIdFromCookie('basalt_session=%')).toBeNull()
    // A well-formed value still decodes.
    expect(auth.sessionIdFromCookie('other=1; basalt_session=abc%2Fdef')).toBe('abc/def')
  })

  for (const adapter of availableAdapters) {
    it(`[${adapter}] a public route answers 200 to a request carrying a malformed session cookie`, async () => {
      const routes = [route({ method: 'GET', url: '/public', async handler() { return { ok: true } } })]
      harness = await boot(adapter, [authPlugin({ users: users(), secret: SECRET })], routes)
      const res = await harness.call({ method: 'GET', url: '/public', headers: { cookie: 'basalt_session=%E0%A4%A' } })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
    })
  }
})

describe('FA-013 — an unset NODE_ENV is production for Auth too', () => {
  const saved = process.env['NODE_ENV']
  afterEach(() => {
    if (saved === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = saved
  })

  for (const value of [undefined, '', 'staging']) {
    it(`NODE_ENV=${JSON.stringify(value)}: a short secret is refused and the session cookie is Secure`, () => {
      if (value === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = value
      expect(() => new Auth({ users: users(), secret: 'short' })).toThrow(/too short/)
      expect(new Auth({ users: users(), secret: SECRET }).sessionCookieHeader('sid')).toContain('Secure')
    })
  }

  it('NODE_ENV=development keeps the dev conveniences (control)', () => {
    process.env['NODE_ENV'] = 'development'
    expect(() => new Auth({ users: users(), secret: 'short' })).not.toThrow()
    expect(new Auth({ users: users(), secret: SECRET }).sessionCookieHeader('sid')).not.toContain('Secure')
  })
})

describe('FA-014 — throttle eviction never unlocks a locked account', () => {
  it('a locked identifier survives a flood of other identifiers', async () => {
    const throttle = new LoginThrottle({ maxAttempts: 2, windowMs: 60_000, maxEntries: 2 })
    await throttle.recordFailure('victim@x')
    await throttle.recordFailure('victim@x')
    await expect(Promise.resolve().then(() => throttle.assertAllowed('victim@x'))).rejects.toThrow(/Too many failed/)
    for (let i = 0; i < 20; i++) await throttle.recordFailure(`junk-${i}@x`)
    await expect(Promise.resolve().then(() => throttle.assertAllowed('victim@x'))).rejects.toThrow(/Too many failed/)
    expect(throttle.size).toBeLessThanOrEqual(2)
  })

  it('reserve() locks count as well', async () => {
    const throttle = new LoginThrottle({ maxAttempts: 2, windowMs: 60_000, maxEntries: 2 })
    await throttle.reserve('victim@x')
    await throttle.reserve('victim@x')
    for (let i = 0; i < 20; i++) await throttle.recordFailure(`junk-${i}@x`)
    await expect(Promise.resolve().then(() => throttle.reserve('victim@x'))).rejects.toThrow(/Too many failed/)
  })

  it('the memory bound stays absolute: when every entry is locked, the oldest lock goes', () => {
    const store = new MemoryThrottleStore({ maxEntries: 2 })
    store.hit('a', 60_000, 1)
    store.hit('b', 60_000, 1)
    store.hit('c', 60_000, 1)
    expect(store.size).toBe(2)
    expect(store.peek('a')).toBeNull()
    expect(store.peek('b')?.count).toBe(1)
  })

  it('without a limit (a custom caller) entries evict oldest-first as before', () => {
    const store = new MemoryThrottleStore({ maxEntries: 2 })
    store.hit('a', 60_000)
    store.hit('a', 60_000)
    store.hit('b', 60_000)
    store.hit('c', 60_000)
    expect(store.peek('a')).toBeNull()
  })
})

describe('FA-042 — JWT strings are not malleable', () => {
  const token = signJwt({ sub: 'u1' }, { secret: SECRET, expiresIn: '1h' })

  it('the canonical token verifies', () => {
    expect(verifyJwt(token, SECRET).sub).toBe('u1')
  })

  it('characters outside the base64url alphabet are rejected in any segment', () => {
    const [head, body, sig] = token.split('.') as [string, string, string]
    for (const bad of [`${token}!!!`, `${token}=`, `${head}.${body}.${sig.slice(0, 10)} ${sig.slice(10)}`, `${head}!.${body}.${sig}`, `${head}.${body}+.${sig}`]) {
      expect(() => verifyJwt(bad, SECRET), bad).toThrow(/invalid/)
    }
  })

  it('a non-canonical final signature character (same bytes) is rejected', () => {
    const [head, body, sig] = token.split('.') as [string, string, string]
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = alphabet.indexOf(sig.at(-1)!)
    // 32 bytes → 43 chars: the final char carries 4 data bits + 2 padding bits.
    const twin = alphabet[last ^ 0b01]!
    const forged = `${head}.${body}.${sig.slice(0, -1)}${twin}`
    expect(Buffer.from(forged.split('.')[2]!, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true)
    expect(() => verifyJwt(forged, SECRET)).toThrow(/invalid/)
  })
})
