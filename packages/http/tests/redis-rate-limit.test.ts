import { describe, expect, it } from 'vitest'
import { RedisRateLimitStore, type RedisLike } from '../src/index.js'

// Fake ioredis surface — simulates INCR + a first-hit TTL (the HIT_SCRIPT effect)
// and records the eval args. No Lua interpreter needed; we assert the store's
// marshalling and result maths.
function fakeRedis() {
  const counts = new Map<string, number>()
  const ttls = new Map<string, number>()
  const evalCalls: { key: string; windowMs: number }[] = []
  const client: RedisLike = {
    async eval(_script, _numKeys, key, windowMs) {
      const k = String(key)
      evalCalls.push({ key: k, windowMs: Number(windowMs) })
      const count = (counts.get(k) ?? 0) + 1
      counts.set(k, count)
      if (count === 1) ttls.set(k, Number(windowMs))
      return [count, ttls.get(k) ?? Number(windowMs)]
    },
    async del(...keys) {
      let n = 0
      for (const key of keys) {
        if (counts.delete(key)) n++
        ttls.delete(key)
      }
      return n
    },
  }
  return { client, counts, evalCalls }
}

describe('RedisRateLimitStore', () => {
  it('counts hits, allows under the limit and blocks over it', async () => {
    const redis = fakeRedis()
    const store = new RedisRateLimitStore(redis.client, { prefix: 'rl', now: () => 1000 })

    const a = await store.hit('ip1', 2, 60_000)
    expect(a).toEqual({ allowed: true, limit: 2, remaining: 1, resetAt: 61_000, retryAfterMs: 60_000 })
    expect(redis.evalCalls[0]).toEqual({ key: 'rl:ip1', windowMs: 60_000 })

    expect((await store.hit('ip1', 2, 60_000)).remaining).toBe(0) // 2nd, still allowed
    const third = await store.hit('ip1', 2, 60_000)
    expect(third.allowed).toBe(false) // 3rd exceeds
    expect(third.remaining).toBe(0)
    expect(third.retryAfterMs).toBe(60_000)
  })

  it('isolates different keys behind the prefix', async () => {
    const redis = fakeRedis()
    const store = new RedisRateLimitStore(redis.client, { prefix: 'rl' })
    await store.hit('a', 5, 1000)
    expect((await store.hit('b', 5, 1000)).remaining).toBe(4) // independent counter
    expect(redis.counts.get('rl:a')).toBe(1)
  })

  it('reset clears the window', async () => {
    const redis = fakeRedis()
    const store = new RedisRateLimitStore(redis.client, { prefix: 'rl' })
    await store.hit('ip', 1, 1000)
    expect((await store.hit('ip', 1, 1000)).allowed).toBe(false)
    await store.reset('ip')
    expect((await store.hit('ip', 1, 1000)).allowed).toBe(true) // window gone
  })
})
