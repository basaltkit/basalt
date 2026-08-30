import { describe, expect, it } from 'vitest'
import { Cache, MemoryCacheDriver } from '../src/index.js'
import { RedisCacheDriver } from '../src/drivers/redis.js'

// ---------------------------------------------------------------------------
// A minimal in-process Redis stand-in: enough of the ioredis surface for the
// cache driver, so the glob/tag semantics can be asserted without a broker.
// ---------------------------------------------------------------------------
class FakeRedis {
  readonly strings = new Map<string, string>()
  readonly sets = new Map<string, Set<string>>()
  readonly zsets = new Map<string, Map<string, number>>()
  readonly expiries = new Map<string, number>()

  async get(key: string) {
    return this.strings.get(key) ?? null
  }
  async set(key: string, raw: string, ..._rest: unknown[]) {
    this.strings.set(key, raw)
    return 'OK'
  }
  async del(...keys: string[]) {
    let n = 0
    for (const key of keys) {
      if (this.strings.delete(key)) n++
      if (this.sets.delete(key)) n++
      if (this.zsets.delete(key)) n++
    }
    return n
  }
  async zadd(key: string, score: string, member: string) {
    const z = this.zsets.get(key) ?? new Map<string, number>()
    this.zsets.set(key, z)
    z.set(member, Number(score))
    return 1
  }
  async zrem(key: string, member: string) {
    const z = this.zsets.get(key)
    if (!z) return 0
    const had = z.delete(member)
    if (z.size === 0) this.zsets.delete(key)
    return had ? 1 : 0
  }
  async zrange(key: string, _s: string, _e: string) {
    return [...(this.zsets.get(key) ?? new Map()).keys()]
  }
  async zremrangebyscore(key: string, _min: string, max: string) {
    const z = this.zsets.get(key)
    if (!z) return 0
    const bound = Number(max.replace('(', ''))
    let n = 0
    for (const [member, score] of z) if (score < bound) { z.delete(member); n++ }
    return n
  }
  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>()
    this.sets.set(key, set)
    for (const m of members) set.add(m)
    return members.length
  }
  async srem(key: string, ...members: string[]) {
    const set = this.sets.get(key)
    if (!set) return 0
    let n = 0
    for (const m of members) if (set.delete(m)) n++
    if (set.size === 0) this.sets.delete(key)
    return n
  }
  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])]
  }
  async pexpire(key: string, ms: number) {
    this.expiries.set(key, ms)
    return 1
  }
  async scan(cursor: string, _m: string, pattern: string, _c: string, _n: number) {
    // Translate the Redis glob (with backslash escapes) into a RegExp.
    let re = ''
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i] as string
      if (c === '\\') {
        i++
        re += (pattern[i] as string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      } else if (c === '*') re += '.*'
      else if (c === '?') re += '.'
      else if (c === '[' || c === ']') re += c
      else re += c.replace(/[.*+?^${}()|\\]/g, '\\$&')
    }
    const rx = new RegExp(`^${re}$`)
    return [cursor === '0' ? '1' : '0', [...this.strings.keys()].filter((k) => rx.test(k))] as [
      string,
      string[],
    ]
  }
  async quit() {
    return 'OK'
  }
}

const redisDriver = () => {
  const redis = new FakeRedis()
  return { redis, driver: new RedisCacheDriver(redis as never) }
}

describe('F-6 · Redis flushPrefix glob injection via tenant id', () => {
  it('a tenant whose id contains a glob metacharacter cannot flush another tenant', async () => {
    const { redis, driver } = redisDriver()
    await driver.set('basalt:tenant:a*:k', 1)
    await driver.set('basalt:tenant:ab:k', 2) // a different tenant, id "ab"

    // The attacker's scope is the literal prefix "basalt:tenant:a*:".
    await driver.flushPrefix('basalt:tenant:a*:')

    expect(redis.strings.has('basalt:tenant:a*:k')).toBe(false)
    expect(redis.strings.has('basalt:tenant:ab:k')).toBe(true)
  })

  it('escapes ?, [ and \\ too', async () => {
    const { redis, driver } = redisDriver()
    await driver.set('basalt:tenant:ab:k', 1)
    await driver.flushPrefix('basalt:tenant:a?:')
    expect(redis.strings.has('basalt:tenant:ab:k')).toBe(true)
  })
})

describe('F-9 · Redis tag sets leak forever', () => {
  it('deleting a key removes it from its tag sets', async () => {
    const { redis, driver } = redisDriver()
    await driver.set('k1', 1, undefined, ['plans'])
    await driver.set('k2', 2, undefined, ['plans'])
    await driver.delete('k1')

    expect(await redis.zrange('__tagz__:plans', '0', '-1')).toEqual(['k2'])
  })

  it('prunes members that have already expired instead of keeping them forever', async () => {
    const { redis, driver } = redisDriver()
    await driver.set('short', 1, 1, ['plans'])
    await new Promise((r) => setTimeout(r, 5))
    await driver.set('long', 2, 60_000, ['plans'])

    expect(await redis.zrange('__tagz__:plans', '0', '-1')).toEqual(['long'])
  })

  it('keeps entries with no TTL in the index forever (+inf score)', async () => {
    const { redis, driver } = redisDriver()
    await driver.set('forever', 1, undefined, ['plans'])
    await new Promise((r) => setTimeout(r, 5))
    await driver.set('other', 2, 60_000, ['plans'])

    expect((await redis.zrange('__tagz__:plans', '0', '-1')).sort()).toEqual(['forever', 'other'])
  })
})

describe('F-8 · memory cache driver is unbounded', () => {
  it('evicts least-recently-used entries past maxEntries', async () => {
    const driver = new MemoryCacheDriver({ maxEntries: 3 })
    await driver.set('a', 1)
    await driver.set('b', 2)
    await driver.set('c', 3)
    await driver.get('a') // 'a' becomes most-recently-used, 'b' the oldest
    await driver.set('d', 4)

    expect(await driver.get('b')).toBeUndefined()
    expect(await driver.get('a')).toBe(1)
    expect(await driver.get('c')).toBe(3)
    expect(await driver.get('d')).toBe(4)
  })

  it('is bounded by default (does not grow without limit)', async () => {
    const driver = new MemoryCacheDriver({ maxEntries: 2 })
    for (let i = 0; i < 1_000; i++) await driver.set(`k${i}`, i)
    expect(driver.size).toBe(2)
  })

  it('prefers evicting already-expired entries over live ones', async () => {
    const driver = new MemoryCacheDriver({ maxEntries: 2 })
    await driver.set('stale', 1, 1)
    await driver.set('live', 2)
    await new Promise((r) => setTimeout(r, 5))
    await driver.set('new', 3)

    expect(await driver.get('live')).toBe(2)
    expect(await driver.get('new')).toBe(3)
  })
})

describe('F-10 · cached undefined is not a miss', () => {
  it('remember() caches a legitimately-undefined factory result', async () => {
    const cache = new Cache(new MemoryCacheDriver(), { scope: null })
    let calls = 0
    const factory = () => {
      calls++
      return undefined
    }

    expect(await cache.remember('u', '1m', factory)).toBeUndefined()
    expect(await cache.remember('u', '1m', factory)).toBeUndefined()
    expect(calls).toBe(1)
  })

  it('get() still reports the fallback for a cached undefined', async () => {
    const cache = new Cache(new MemoryCacheDriver(), { scope: null })
    await cache.remember('u', '1m', () => undefined)
    expect(await cache.get('u', 'fallback')).toBe('fallback')
  })

  it('put(undefined) stores valid JSON (ioredis would otherwise write "undefined")', async () => {
    const { redis, driver } = redisDriver()
    const cache = new Cache(driver, { scope: null })
    await cache.put('u', undefined, '1m')
    const raw = redis.strings.get('basalt:u')
    expect(typeof raw).toBe('string')
    expect(() => JSON.parse(raw as string)).not.toThrow()
    expect(await cache.get('u')).toBeUndefined()
  })
})
