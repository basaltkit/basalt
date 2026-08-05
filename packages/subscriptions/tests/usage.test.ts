import { describe, expect, it } from 'vitest'
import {
  definePlans,
  meter,
  MemoryUsageStore,
  QuotaExceededError,
  RedisUsageStore,
  Subscriptions,
  type RedisLike,
} from '../src/index.js'

describe('MemoryUsageStore.consume', () => {
  it('is atomic under concurrency — never overshoots the limit', async () => {
    const store = new MemoryUsageStore()
    // 10 concurrent consumes of 1, limit 5 → exactly 5 applied, usage 5
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.consume('acme', 'api', 'lifetime', 1, 5)),
    )
    expect(results.filter((r) => r.applied)).toHaveLength(5)
    expect(await store.get('acme', 'api', 'lifetime')).toBe(5)
  })

  it('reports usage without applying when over the limit', async () => {
    const store = new MemoryUsageStore()
    await store.consume('acme', 'api', 'lifetime', 4, 5)
    const rejected = await store.consume('acme', 'api', 'lifetime', 2, 5)
    expect(rejected).toEqual({ applied: false, used: 4 })
  })
})

/** Emulates Redis EVAL of the consume script — enough to test the driver's
 *  arg marshalling and reply handling. Real atomicity is Redis's EVAL guarantee. */
function fakeRedis() {
  const store = new Map<string, number>()
  const ttls = new Map<string, number>()
  const evalCalls: { key: string; amount: number; limit: number; ttl: number }[] = []
  const client: RedisLike = {
    async get(key) {
      return store.has(key) ? String(store.get(key)) : null
    },
    async eval(_script, _numKeys, key, amount, limit, ttl) {
      const k = String(key)
      const call = { key: k, amount: Number(amount), limit: Number(limit), ttl: Number(ttl) }
      evalCalls.push(call)
      const current = store.get(k) ?? 0
      if (current + call.amount > call.limit) return [0, current]
      const total = current + call.amount
      store.set(k, total)
      if (call.ttl > 0) ttls.set(k, call.ttl)
      return [1, total]
    },
  }
  return { client, store, ttls, evalCalls }
}

describe('RedisUsageStore', () => {
  it('consume marshals key/amount/limit/ttl and parses the reply', async () => {
    const redis = fakeRedis()
    const store = new RedisUsageStore(redis.client, { prefix: 'u', ttlSeconds: 3600 })

    const ok = await store.consume('acme', 'api.requests', '2026-08', 5, 100)
    expect(ok).toEqual({ applied: true, used: 5 })
    expect(redis.evalCalls[0]).toEqual({
      key: 'u:acme:api.requests:2026-08',
      amount: 5,
      limit: 100,
      ttl: 3600, // monthly bucket → TTL set
    })

    const rejected = await store.consume('acme', 'api.requests', '2026-08', 200, 100)
    expect(rejected).toEqual({ applied: false, used: 5 })
  })

  it('lifetime counters get no TTL; get reads the value', async () => {
    const redis = fakeRedis()
    const store = new RedisUsageStore(redis.client)

    await store.increment('acme', 'projects', 'lifetime', 3)
    expect(redis.evalCalls[0]?.ttl).toBe(0)
    expect(redis.evalCalls[0]?.limit).toBe(Number.MAX_SAFE_INTEGER) // unlimited path
    expect(await store.get('acme', 'projects', 'lifetime')).toBe(3)
  })
})

describe('Subscriptions.consume over a Redis usage store', () => {
  const plans = definePlans({
    pro: {
      price: 29,
      features: { seats: Number.POSITIVE_INFINITY, 'api.requests': meter(1000) },
    },
  })

  it('enforces metered limits atomically and tracks unlimited features', async () => {
    const redis = fakeRedis()
    const subscriptions = new Subscriptions({ plans, usage: new RedisUsageStore(redis.client) })
    await subscriptions.subscribe('acme', 'pro')
    const features = subscriptions.features('acme')

    await features.consume('api.requests', 999)
    await expect(features.consume('api.requests', 2)).rejects.toBeInstanceOf(QuotaExceededError)
    expect(await features.remaining('api.requests')).toBe(1)

    // unlimited feature just tracks, no limit rejection
    await features.consume('seats', 50)
    expect(await features.usage('seats')).toBe(50)
  })
})
