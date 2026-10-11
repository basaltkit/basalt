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

  it('__Host- with secure: false refuses with AUTH_SESSION_COOKIE_INVALID', () => {
    const warn = spyWarn()
    const build = () => new Auth({ users, secret, sessionCookie: { name: '__Host-sid', secure: false } })
    expect(build).toThrow(SessionCookieConfigError)
    try {
      build()
    } catch (error) {
      expect(error).toMatchObject({ code: 'AUTH_SESSION_COOKIE_INVALID', status: 500 })
      expect((error as Error).message).toContain('__Host-sid')
      expect((error as Error).message).toContain('secure: true')
      expect((error as Error).message).toContain("isProd ? '__Host-sid' : 'sid'")
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('__Host- with another path refuses, and the refusal is not deduplicated', () => {
    const warn = spyWarn()
    const sessionCookie = { name: '__Host-sid', path: '/app' }
    // The same options object refuses on every resolution (registration and AUTH).
    expect(() => new Auth({ users, secret, sessionCookie })).toThrow(/path "\/"/)
    expect(() => new Auth({ users, secret, sessionCookie })).toThrow(SessionCookieConfigError)
    // A refused configuration prints no implied-Secure warning on top.
    expect(warn).not.toHaveBeenCalled()
  })

  it('__Host- with secure: false and a sub-path names both problems', () => {
    expect(() => new Auth({ users, secret, sessionCookie: { name: '__Host-sid', secure: false, path: '/app' } })).toThrow(
      'requires secure: true and path "/"',
    )
  })

  it('__Secure- implies Secure, allows any path, and refuses an explicit secure: false', () => {
    const warn = spyWarn()
    expect(() => new Auth({ users, secret, sessionCookie: { name: '__Secure-sid', secure: false } })).toThrow(
      SessionCookieConfigError,
    )
    const auth = new Auth({ users, secret, sessionCookie: { name: '__Secure-sid', path: '/app', secure: true } })
    expect(auth.sessionCookieHeader('abc')).toContain('Path=/app;')
    expect(auth.sessionCookieHeader('abc')).toContain('; Secure')
    expect(warn).not.toHaveBeenCalled()
  })

  it('refuses in production as in development (the prefix rule does not depend on NODE_ENV)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    try {
      expect(() => new Auth({ users, secret, sessionCookie: { name: '__secure-sid', secure: false } })).toThrow(
        SessionCookieConfigError,
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("the documented pattern boots in every environment: name: isProd ? '__Host-sid' : 'sid'", () => {
    const warn = spyWarn()
    for (const isProd of [true, false]) {
      const auth = new Auth({
        users,
        secret,
        sessionCookie: { name: isProd ? '__Host-sid' : 'sid', secure: isProd },
      })
      expect(auth.sessionCookieHeader('abc').includes('; Secure')).toBe(isProd)
    }
    expect(warn).not.toHaveBeenCalled()
  })

  it('an unprefixed name keeps the environment default', () => {
    const warn = spyWarn()
    const auth = new Auth({ users, secret, sessionCookie: { name: 'sid', secure: false, path: '/app' } })
    expect(auth.sessionCookieHeader('abc')).not.toContain('; Secure')
    expect(warn).not.toHaveBeenCalled()
  })

  it('authPlugin refuses a violating cookie at boot', async () => {
    const app = createApp({ plugins: [authPlugin({ users, secret, sessionCookie: { name: '__Host-sid', path: '/api' } })] })
    await expect(app.boot()).rejects.toMatchObject({ code: 'AUTH_SESSION_COOKIE_INVALID' })
  })

  it('authPlugin warns about an implied Secure once across registration and the AUTH singleton', async () => {
    const warn = spyWarn()
    const app = createApp({ plugins: [authPlugin({ users, secret, sessionCookie: { name: '__Host-sid' } })] })
    await app.boot()
    try {
      expect(app.container.get(AUTH).sessionCookieHeader('abc')).toContain('; Secure')
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('Secure is implied by the prefix')
    } finally {
      await app.shutdown()
    }
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

  type Warning = 'implied' | 'samesite'
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
    // Browsers drop a prefixed cookie that breaks its prefix rule: refused at boot.
    const refused = (prefixed && !secure) || (host && path !== '/')
    const browserAccepts = !refused && !(sameSite === 'None' && !secure)
    const warnings: Warning[] = []
    if (secure !== previousSecure) warnings.push('implied')
    if (!prefixed && sameSite === 'None' && !secure) warnings.push('samesite')
    return { path, secure, sameSite, refused, browserAccepts, changed: secure !== previousSecure, warnings }
  }

  const classify = (message: string): Warning => {
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

    if (want.refused) {
      expect(() => new Auth({ users, secret, sessionCookie })).toThrow(SessionCookieConfigError)
      expect(warn).not.toHaveBeenCalled()
      return
    }

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
    // The invariants: nothing browsers drop for its prefix boots, and nothing
    // else they drop or that differs from earlier releases goes out silently.
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

  it('a __Host- cookie that breaks its prefix rule refuses to boot', async () => {
    for (const sessionCookie of [{ name: '__Host-sid', secure: false }, { name: '__Host-sid', path: '/api' }]) {
      const booting = boot(adapter, [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher, sessionCookie })], routes)
      await expect(booting).rejects.toMatchObject({ code: 'AUTH_SESSION_COOKIE_INVALID' })
    }
  })

  it('a __Host- cookie is issued with Secure and Path=/', async () => {
    const { raw, cookie } = await setup({ sessionCookie: { name: '__Host-sid' } })
    expect(cookie.startsWith('__Host-sid=')).toBe(true)
    expect(raw).toContain('Path=/;')
    expect(raw).toContain('Secure')
  })
})
