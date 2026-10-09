import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, ctx } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import {
  AUTH,
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

  it('rollout: enabling it measures an untouched session from its creation (documented one-time sign-out)', async () => {
    freezeClock(T0)
    const store = new MemorySessionStore()
    const users = new MemoryUserSource()
    const before = new Auth({ users, secret, hasher: fastHasher, sessions: store })
    const user = await before.register('rollout@acme.test', 'password123')
    const old = await before.createSession(user.id)
    vi.setSystemTime(T0 + 2 * 60 * MIN)
    expect(await before.sessionUser(old.id)).not.toBeNull() // in use, but nothing touches it

    const after = new Auth({ users, secret, hasher: fastHasher, sessions: store, sessionIdleTtl: '30m' })
    const fresh = await after.createSession(user.id)
    vi.setSystemTime(T0 + 2 * 60 * MIN + MIN)
    expect(await after.sessionUser(old.id)).toBeNull()
    expect(await after.sessionUser(fresh.id)).not.toBeNull()
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

  /** Captures console.warn for the duration of one test. */
  const spyWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('__Host- forces Secure and Path=/ when unset', () => {
    const warn = spyWarn()
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Host-sid' } })
    const header = auth.sessionCookieHeader('abc')
    expect(header.startsWith('__Host-sid=abc; Path=/;')).toBe(true)
    expect(header).toContain('; Secure')
    expect(header).not.toContain('Domain')
    expect(auth.expiredSessionCookieHeader()).toContain('; Secure')
    // Outside production the implied Secure is new behaviour: one warning.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('Secure is implied by the prefix')
    expect(String(warn.mock.calls[0]?.[0])).toContain('__Host-sid')
  })

  it('an explicit secure: true on a prefixed name does not warn', () => {
    const warn = spyWarn()
    new Auth({ users, secret, sessionCookie: { name: '__Host-sid', path: '/', secure: true } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('an implied Secure does not warn in production', () => {
    const warn = spyWarn()
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const auth = new Auth({ users, secret, sessionCookie: { name: '__Host-sid' } })
      expect(auth.sessionCookieHeader('abc')).toContain('; Secure')
    } finally {
      vi.unstubAllEnvs()
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('__Host- with secure: false boots, warns and keeps the cookie non-Secure (as before)', () => {
    const warn = spyWarn()
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Host-sid', secure: false } })
    expect(auth.sessionCookieHeader('abc')).not.toContain('; Secure')
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0]?.[0])
    expect(message).toContain('__Host-sid')
    expect(message).toContain('secure: true')
    expect(message).toContain('next major')
  })

  it('__Host- with another path boots, warns and keeps the configured path (as before)', () => {
    const warn = spyWarn()
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Host-sid', path: '/app' } })
    expect(auth.sessionCookieHeader('abc')).toContain('Path=/app;')
    // Two independent warnings: the path makes browsers drop it, and (outside
    // production) the implied Secure differs from earlier versions.
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toContain('path "/"')
    expect(String(warn.mock.calls[1]?.[0])).toContain('Secure is implied by the prefix')
  })

  it('__Secure- implies Secure, allows any path, and keeps an explicit secure: false with a warning', () => {
    const warn = spyWarn()
    const loose = new Auth({ users, secret, sessionCookie: { name: '__Secure-sid', secure: false } })
    expect(loose.sessionCookieHeader('abc')).not.toContain('; Secure')
    expect(warn).toHaveBeenCalledTimes(1)
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Secure-sid', path: '/app', secure: true } })
    expect(auth.sessionCookieHeader('abc')).toContain('Path=/app;')
    expect(auth.sessionCookieHeader('abc')).toContain('; Secure')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('an unprefixed name keeps the environment default', () => {
    const warn = spyWarn()
    const auth = new Auth({ users, secret, sessionCookie: { name: 'sid', secure: false, path: '/app' } })
    expect(auth.sessionCookieHeader('abc')).not.toContain('; Secure')
    expect(warn).not.toHaveBeenCalled()
  })

  it('authPlugin boots a violating cookie and warns once across registration and the AUTH singleton', async () => {
    const warn = spyWarn()
    const app = createApp({ plugins: [authPlugin({ users, secret, sessionCookie: { name: '__Host-sid', path: '/api' } })] })
    await app.boot()
    try {
      const auth = app.container.get(AUTH)
      expect(auth.sessionCookieHeader('abc')).toContain('Path=/api;')
      // Path + implied Secure (test env): each warned once, not once per resolution.
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0]?.[0])).toContain('__Host-sid')
      expect(String(warn.mock.calls[1]?.[0])).toContain('__Host-sid')
    } finally {
      await app.shutdown()
    }
  })

  it('keeps SessionCookieConfigError exported for the next major', () => {
    expect(new SessionCookieConfigError('x').code).toBe('AUTH_SESSION_COOKIE_INVALID')
  })
})

/**
 * Every combination of name prefix × `secure` × `path` × environment: the
 * emitted Set-Cookie attributes and the boot warnings. The oracle below is
 * written from the browser rules and from the previous release's behaviour
 * (`secure ?? isProduction`, path as given), independently of the resolver.
 */
describe('session cookie matrix (BK-076)', () => {
  const users = new MemoryUserSource()
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  type Warning = 'dropped' | 'implied' | 'samesite'
  interface Row {
    name: string
    secure: boolean | undefined
    path: string | undefined
    production: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
  }

  const names = ['sid', '__Secure-sid', '__Host-sid', '__secure-sid', '__HOST-sid']
  const rows: Row[] = []
  for (const name of names)
    for (const secure of [undefined, true, false])
      for (const path of [undefined, '/', '/app'])
        for (const production of [false, true]) rows.push({ name, secure, path, production })
  for (const secure of [undefined, true, false])
    for (const production of [false, true]) rows.push({ name: 'sid', secure, path: undefined, production, sameSite: 'None' })

  const expected = (row: Row) => {
    const lower = row.name.toLowerCase()
    const host = lower.startsWith('__host-')
    const prefixed = host || lower.startsWith('__secure-')
    const path = row.path ?? '/'
    const secure = row.secure ?? (prefixed || row.production)
    const previousSecure = row.secure ?? row.production
    const sameSite = row.sameSite ?? 'Lax'
    const browserAccepts =
      !(prefixed && !secure) && !(host && path !== '/') && !(sameSite === 'None' && !secure)
    const warnings: Warning[] = []
    if ((prefixed && !secure) || (host && path !== '/')) warnings.push('dropped')
    if (secure !== previousSecure) warnings.push('implied')
    if (!prefixed && sameSite === 'None' && !secure) warnings.push('samesite')
    return { path, secure, sameSite, browserAccepts, changed: secure !== previousSecure, warnings }
  }

  const classify = (message: string): Warning => {
    if (message.includes('browsers drop it; this will refuse')) return 'dropped'
    if (message.includes('Secure is implied by the prefix')) return 'implied'
    if (message.includes('SameSite=None without Secure')) return 'samesite'
    throw new Error(`unexpected warning: ${message}`)
  }

  it.each(rows)('%o', (row) => {
    vi.stubEnv('NODE_ENV', row.production ? 'production' : 'test')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sessionCookie = {
      name: row.name,
      ...(row.secure === undefined ? {} : { secure: row.secure }),
      ...(row.path === undefined ? {} : { path: row.path }),
      ...(row.sameSite === undefined ? {} : { sameSite: row.sameSite }),
    }
    const want = expected(row)

    const auth = new Auth({ users, secret, sessionCookie })
    // A second resolution of the same options object (authPlugin + AUTH) never re-warns.
    new Auth({ users, secret, sessionCookie })

    for (const header of [auth.sessionCookieHeader('abc'), auth.expiredSessionCookieHeader()]) {
      const attributes = header.split('; ')
      expect(attributes[0]?.startsWith(`${row.name}=`)).toBe(true)
      expect(attributes).toContain(`Path=${want.path}`)
      expect(attributes).toContain(`SameSite=${want.sameSite}`)
      expect(attributes.includes('Secure')).toBe(want.secure)
      expect(header).not.toMatch(/Domain=/i)
    }

    const got = warn.mock.calls.map((call) => classify(String(call[0])))
    expect(got).toEqual(want.warnings)
    for (const call of warn.mock.calls) expect(String(call[0])).toContain(row.name)
    // The invariants the minor promises: nothing browsers drop and nothing
    // that differs from the previous release goes out without a warning.
    if (!want.browserAccepts) expect(got.length).toBeGreaterThan(0)
    if (want.changed) expect(got).toContain('implied')
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
