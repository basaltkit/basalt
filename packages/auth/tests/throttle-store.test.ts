import { describe, expect, it } from 'vitest'
import {
  AccountLockedError,
  Auth,
  InvalidCredentialsError,
  LoginThrottle,
  MemoryThrottleStore,
  MemoryUserSource,
  RedisThrottleStore,
  type PasswordHasher,
  type RedisThrottleClient,
} from '../src/index.js'

/**
 * BK-009: the login / MFA / email-request throttles share their counters
 * through a {@link ThrottleStore}, so a cluster of replicas enforces ONE budget.
 * The fake Redis below executes each script as one uninterruptible step, like
 * the real single-threaded server, with an optional network delay around it.
 */
function fakeRedis(options: { latencyMs?: number; now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now())
  const values = new Map<string, { count: number; expiresAt: number | null }>()
  const live = (key: string) => {
    const entry = values.get(key)
    if (entry && entry.expiresAt !== null && now() >= entry.expiresAt) {
      values.delete(key)
      return undefined
    }
    return entry
  }
  const pttl = (key: string) => {
    const entry = live(key)
    if (!entry) return -2
    return entry.expiresAt === null ? -1 : entry.expiresAt - now()
  }
  const delay = () => new Promise((resolve) => setTimeout(resolve, options.latencyMs ?? 0))
  const scripts: string[] = []
  const client: RedisThrottleClient = {
    async eval(script, _numKeys, ...args) {
      await delay()
      scripts.push(script)
      const key = String(args[0])
      let result: unknown
      if (script.includes("'INCR'")) {
        const windowMs = Number(args[1])
        const entry = live(key) ?? { count: 0, expiresAt: null }
        entry.count += 1
        values.set(key, entry)
        if (entry.count === 1 || pttl(key) < 0) entry.expiresAt = now() + windowMs
        result = [entry.count, pttl(key)]
      } else if (script.includes("'DECR'")) {
        const entry = live(key) ?? { count: 0, expiresAt: null }
        entry.count -= 1
        if (entry.count <= 0) values.delete(key)
        else values.set(key, entry)
        result = entry.count
      } else if (script.includes("'GET'")) {
        const entry = live(key)
        result = entry ? [entry.count, pttl(key)] : [0, 0]
      } else {
        throw new Error(`unexpected script: ${script}`)
      }
      await delay()
      return result
    },
    async del(...keys) {
      await delay()
      let n = 0
      for (const key of keys) if (values.delete(key)) n++
      return n
    },
  }
  return { client, values, scripts }
}

/** Counts how many password verifications actually ran. */
function countingHasher() {
  let verifications = 0
  const hasher: PasswordHasher = {
    hash: async (password) => `plain:${password}`,
    verify: async (password, hash) => {
      verifications++
      return hash === `plain:${password}`
    },
  }
  return { hasher, verifications: () => verifications }
}

const secret = 'test-secret-test-secret-test-secret'

describe('RedisThrottleStore', () => {
  it('counts hits in a fixed window, peeks, releases and resets', async () => {
    let now = 1_000
    const redis = fakeRedis({ now: () => now })
    const store = new RedisThrottleStore(redis.client, { prefix: 't' })

    expect(await store.peek('k')).toBeNull()
    expect(await store.hit('k', 60_000)).toEqual({ count: 1, retryAfterMs: 60_000 })
    now += 10_000
    expect(await store.hit('k', 60_000)).toEqual({ count: 2, retryAfterMs: 50_000 })
    expect(await store.peek('k')).toEqual({ count: 2, retryAfterMs: 50_000 })
    expect([...redis.values.keys()]).toEqual(['t:k'])

    await store.release('k')
    expect((await store.peek('k'))?.count).toBe(1)
    await store.release('k')
    expect(await store.peek('k')).toBeNull()

    await store.hit('k', 60_000)
    await store.reset('k')
    expect(await store.peek('k')).toBeNull()

    await store.hit('k', 1_000)
    now += 1_001
    expect(await store.peek('k')).toBeNull() // the window expired server-side
  })

  it('never stores the raw identifier (keys are digests under the prefix)', async () => {
    const redis = fakeRedis()
    const throttle = new LoginThrottle({ store: new RedisThrottleStore(redis.client), namespace: 'login' })
    await throttle.recordFailure('victim@acme.test')
    const [key] = [...redis.values.keys()]
    expect(key).toMatch(/^basalt:throttle:login:[A-Za-z0-9_-]{43}$/)
    expect(key).not.toContain('victim')
  })
})

describe('LoginThrottle over a shared store', () => {
  it('two replicas enforce ONE budget: failures on A lock the account on B', async () => {
    const redis = fakeRedis()
    const users = new MemoryUserSource()
    const { hasher } = countingHasher()
    const replica = () =>
      new Auth({
        users,
        secret,
        hasher,
        ipLoginThrottle: false,
        loginThrottle: new LoginThrottle({ maxAttempts: 3, store: new RedisThrottleStore(redis.client) }),
      })
    const a = replica()
    const b = replica()
    await a.register('user@acme.test', 'password123')

    for (let i = 0; i < 3; i++) {
      await expect((i % 2 ? a : b).login('user@acme.test', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
    }
    await expect(b.login('user@acme.test', 'password123')).rejects.toBeInstanceOf(AccountLockedError)
    await expect(a.login('user@acme.test', 'password123')).rejects.toBeInstanceOf(AccountLockedError)
  })

  it('a concurrent burst runs at most maxAttempts password checks (atomic hit), across replicas', async () => {
    const redis = fakeRedis({ latencyMs: 2 })
    const users = new MemoryUserSource()
    const counter = countingHasher()
    const store = new RedisThrottleStore(redis.client)
    const replicas = [0, 1, 2].map(
      () =>
        new Auth({
          users,
          secret,
          hasher: counter.hasher,
          ipLoginThrottle: false,
          loginThrottle: new LoginThrottle({ maxAttempts: 5, store }),
        }),
    )
    await replicas[0]!.register('user@acme.test', 'password123')
    const before = counter.verifications()

    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) => replicas[i % 3]!.login('user@acme.test', 'wrong')),
    )
    expect(counter.verifications() - before).toBe(5)
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof AccountLockedError)).toHaveLength(25)
  })

  it('a successful login gives its reservation back and clears the counter', async () => {
    const redis = fakeRedis()
    const auth = new Auth({
      users: new MemoryUserSource(),
      secret,
      hasher: countingHasher().hasher,
      ipLoginThrottle: false,
      loginThrottle: new LoginThrottle({ maxAttempts: 2, store: new RedisThrottleStore(redis.client) }),
    })
    await auth.register('user@acme.test', 'password123')
    await expect(auth.login('user@acme.test', 'wrong')).rejects.toBeInstanceOf(InvalidCredentialsError)
    await auth.login('user@acme.test', 'password123')
    expect(redis.values.size).toBe(0)
  })

  it('throttleStore on Auth backs every default throttle (login, ip, email requests) in separate namespaces', async () => {
    const redis = fakeRedis()
    const store = new RedisThrottleStore(redis.client)
    const users = new MemoryUserSource()
    const replica = () => new Auth({ users, secret, hasher: countingHasher().hasher, throttleStore: store })
    const a = replica()
    const b = replica()
    await a.register('user@acme.test', 'password123')

    await expect(a.login('user@acme.test', 'wrong', undefined, { ip: '203.0.113.7' })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    )
    const namespaces = [...redis.values.keys()].map((k) => k.split(':')[2]).sort()
    expect(namespaces).toEqual(['login', 'login-ip'])

    // Email requests: default budget of 3 per account, shared across replicas.
    expect(await a.requestPasswordReset('user@acme.test')).not.toBeNull()
    expect(await b.requestPasswordReset('user@acme.test')).not.toBeNull()
    expect(await a.requestPasswordReset('user@acme.test')).not.toBeNull()
    expect(await b.requestPasswordReset('user@acme.test')).toBeNull()
    expect([...redis.values.keys()].some((k) => k.startsWith('basalt:throttle:email-request:'))).toBe(true)
  })
})

describe('MemoryThrottleStore (the default)', () => {
  it('keeps LoginThrottle synchronous so existing callers are unaffected', () => {
    const throttle = new LoginThrottle({ maxAttempts: 2, store: new MemoryThrottleStore() })
    throttle.reserve('a')
    throttle.reserve('a')
    expect(() => throttle.reserve('a')).toThrow(AccountLockedError)
    expect(() => throttle.assertAllowed('a')).toThrow(AccountLockedError)
    throttle.reset('a')
    expect(() => throttle.assertAllowed('a')).not.toThrow()
  })
})
