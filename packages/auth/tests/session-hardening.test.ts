import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, ctx } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import {
  Auth,
  MemorySessionStore,
  MemoryUserSource,
  SessionCookieConfigError,
  SessionIdleConfigError,
  authPlugin,
  authRoutes,
  type AuthPluginOptions,
  type SessionStore,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * BK-076: generic session hardening — an idle timeout on server-side sessions,
 * and the browser's `__Host-` / `__Secure-` cookie-prefix rules checked at boot.
 */

const secret = 'test-secret-test-secret-test-secret'
const T0 = 1_800_000_000_000
const MIN = 60_000

afterEach(() => {
  vi.useRealTimers()
})

/** Fakes only Date, so HTTP servers and their timers keep working. */
const freezeClock = (at: number) => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(at)
}

/** A memory store that counts touch() calls. */
const countingStore = () => {
  const store = new MemorySessionStore()
  const touches: number[] = []
  const touch = store.touch.bind(store)
  store.touch = async (id, at) => {
    touches.push(at)
    await touch(id, at)
  }
  return { store, touches }
}

async function userWithSession(options: Partial<ConstructorParameters<typeof Auth>[0]> = {}) {
  const users = new MemoryUserSource()
  const auth = new Auth({ users, secret, hasher: fastHasher, ...options })
  const user = await auth.register('idle@acme.test', 'password123')
  const session = await auth.createSession(user.id)
  return { auth, session }
}

describe('sessionIdleTtl (BK-076)', () => {
  it('refuses and deletes a session idle for longer than the window', async () => {
    freezeClock(T0)
    const { store } = countingStore()
    const { auth, session } = await userWithSession({ sessions: store, sessionIdleTtl: '30m' })
    vi.setSystemTime(T0 + 29 * MIN)
    expect(await auth.sessionUser(session.id)).not.toBeNull()
    vi.setSystemTime(T0 + 29 * MIN + 31 * MIN)
    expect(await auth.sessionUser(session.id)).toBeNull()
    expect(await store.find(session.id)).toBeNull()
  })

  it('activity keeps a session alive past the idle window', async () => {
    freezeClock(T0)
    const { auth, session } = await userWithSession({ sessionIdleTtl: '10m' })
    for (let i = 1; i <= 12; i++) {
      vi.setSystemTime(T0 + i * 5 * MIN) // one hour of use, a request every 5 minutes
      expect(await auth.sessionUser(session.id)).not.toBeNull()
    }
  })

  it('throttles touch to once per min(60s, idle/4)', async () => {
    freezeClock(T0)
    const { store, touches } = countingStore()
    const { auth, session } = await userWithSession({ sessions: store, sessionIdleTtl: '30m' })
    for (let s = 1; s <= 59; s++) {
      vi.setSystemTime(T0 + s * 1_000)
      await auth.sessionUser(session.id)
    }
    expect(touches).toEqual([]) // creation set lastSeenAt; under a minute since
    vi.setSystemTime(T0 + 60_000)
    await auth.sessionUser(session.id)
    expect(touches).toEqual([T0 + 60_000])

    // A short idle window touches more often: every idle/4.
    const short = countingStore()
    const second = await userWithSession({ sessions: short.store, sessionIdleTtl: '2m' })
    vi.setSystemTime(T0 + 60_000 + 29_000)
    await second.auth.sessionUser(second.session.id)
    expect(short.touches).toEqual([])
    vi.setSystemTime(T0 + 60_000 + 30_000)
    await second.auth.sessionUser(second.session.id)
    expect(short.touches).toHaveLength(1)
  })

  it('the absolute sessionTtl still applies to an active session', async () => {
    freezeClock(T0)
    const { auth, session } = await userWithSession({ sessionTtl: '1h', sessionIdleTtl: '30m' })
    for (let i = 1; i <= 5; i++) {
      vi.setSystemTime(T0 + i * 10 * MIN)
      expect(await auth.sessionUser(session.id)).not.toBeNull()
    }
    vi.setSystemTime(T0 + 61 * MIN)
    expect(await auth.sessionUser(session.id)).toBeNull()
  })

  it('without sessionIdleTtl nothing changes: no touch, no idle expiry', async () => {
    freezeClock(T0)
    const { store, touches } = countingStore()
    const { auth, session } = await userWithSession({ sessions: store })
    vi.setSystemTime(T0 + 20 * 24 * 60 * MIN)
    expect(await auth.sessionUser(session.id)).not.toBeNull()
    expect(touches).toEqual([])
  })

  it('refuses a store without touch, and a non-positive window, at construction and at plugin registration', async () => {
    const legacy: SessionStore = {
      create: async (userId, ttl) => ({ id: 'x', userId, expiresAt: Date.now() + ttl }),
      find: async () => null,
      delete: async () => false,
    }
    const users = new MemoryUserSource()
    expect(() => new Auth({ users, secret, sessions: legacy, sessionIdleTtl: '30m' })).toThrow(SessionIdleConfigError)
    expect(() => new Auth({ users, secret, sessionIdleTtl: 0 })).toThrow(SessionIdleConfigError)
    expect(() => new Auth({ users, secret, sessions: legacy })).not.toThrow()
    await expect(createApp({ plugins: [authPlugin({ users, secret, sessions: legacy, sessionIdleTtl: '30m' })] }).boot()).rejects.toThrow(
      SessionIdleConfigError,
    )
  })
})

describe('session cookie prefixes (BK-076)', () => {
  const users = new MemoryUserSource()

  it('__Host- forces Secure and Path=/ when unset', () => {
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Host-sid' } })
    const header = auth.sessionCookieHeader('abc')
    expect(header.startsWith('__Host-sid=abc; Path=/;')).toBe(true)
    expect(header).toContain('; Secure')
    expect(header).not.toContain('Domain')
    expect(auth.expiredSessionCookieHeader()).toContain('; Secure')
  })

  it('__Host- with secure: false or another path fails at construction', () => {
    expect(() => new Auth({ users, secret, sessionCookie: { name: '__Host-sid', secure: false } })).toThrow(SessionCookieConfigError)
    expect(() => new Auth({ users, secret, sessionCookie: { name: '__Host-sid', path: '/app' } })).toThrow(SessionCookieConfigError)
    expect(() => new Auth({ users, secret, sessionCookie: { name: '__Host-sid', path: '/', secure: true } })).not.toThrow()
  })

  it('__Secure- forces Secure but allows any path', () => {
    expect(() => new Auth({ users, secret, sessionCookie: { name: '__Secure-sid', secure: false } })).toThrow(SessionCookieConfigError)
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Secure-sid', path: '/app' } })
    expect(auth.sessionCookieHeader('abc')).toContain('Path=/app;')
    expect(auth.sessionCookieHeader('abc')).toContain('; Secure')
  })

  it('an unprefixed name keeps the environment default', () => {
    const auth = new Auth({ users, secret, sessionCookie: { name: 'sid', secure: false, path: '/app' } })
    expect(auth.sessionCookieHeader('abc')).not.toContain('Secure')
  })

  it('authPlugin refuses a violating cookie at boot', async () => {
    await expect(
      createApp({ plugins: [authPlugin({ users, secret, sessionCookie: { name: '__Host-sid', path: '/api' } })] }).boot(),
    ).rejects.toThrow(SessionCookieConfigError)
  })
})

describe.each(availableAdapters)('%s: idle cookie session over HTTP (BK-076)', (adapter) => {
  let harness: Harness | undefined
  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  const routes = [
    ...authRoutes({ rateLimit: false }),
    route({ method: 'GET', url: '/profile', meta: { auth: true }, handler: () => ({ by: ctx().user?.id }) }),
  ]

  async function setup(extra: Partial<AuthPluginOptions> = {}) {
    harness = await boot(adapter, [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher, ...extra })], routes)
    const h = harness
    await h.call({ method: 'POST', url: '/auth/register', payload: { email: 'v@acme.test', password: 'password123' } })
    const login = await h.call({ method: 'POST', url: '/auth/login', payload: { email: 'v@acme.test', password: 'password123' } })
    const setCookie = login.headers['set-cookie']
    const raw = String(Array.isArray(setCookie) ? setCookie[0] : setCookie)
    return { h, raw, cookie: raw.split(';')[0]! }
  }

  it('an idle cookie session answers 401; an active one stays signed in', async () => {
    freezeClock(T0)
    const { h, cookie } = await setup({ sessionIdleTtl: '15m' })
    vi.setSystemTime(T0 + 14 * MIN)
    expect((await h.call({ method: 'GET', url: '/profile', headers: { cookie } })).status).toBe(200)
    vi.setSystemTime(T0 + 28 * MIN)
    expect((await h.call({ method: 'GET', url: '/profile', headers: { cookie } })).status).toBe(200)
    vi.setSystemTime(T0 + 28 * MIN + 16 * MIN)
    const idle = await h.call({ method: 'GET', url: '/profile', headers: { cookie } })
    expect(idle.status).toBe(401)
  })

  it('a __Host- cookie is issued with Secure and Path=/', async () => {
    const { raw, cookie } = await setup({ sessionCookie: { name: '__Host-sid' } })
    expect(cookie.startsWith('__Host-sid=')).toBe(true)
    expect(raw).toContain('Path=/;')
    expect(raw).toContain('Secure')
  })
})
