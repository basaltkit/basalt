import { describe, expect, it } from 'vitest'
import { RedisIdempotencyStore, type RedisLike } from '../src/index.js'

// Fake ioredis surface — a string keyspace, recording set args so we can assert
// the PX ttl marshalling.
function fakeRedis() {
  const store = new Map<string, string>()
  const setCalls: unknown[][] = []
  const client: RedisLike = {
    async get(key) {
      return store.get(key) ?? null
    },
    async set(key, value, ...args) {
      setCalls.push([key, value, ...args])
      // Honour NX: only write when the key is absent, mirroring Redis' return of
      // null for a rejected SET so we can exercise the atomic reservation path.
      if (args.includes('NX') && store.has(key)) return null
      store.set(key, value)
      return 'OK'
    },
    async del(...keys) {
      let n = 0
      for (const key of keys) if (store.delete(key)) n++
      return n
    },
  }
  return { client, store, setCalls }
}

describe('RedisIdempotencyStore', () => {
  it('runs the pending → complete → replay lifecycle', async () => {
    const redis = fakeRedis()
    const s = new RedisIdempotencyStore(redis.client, { prefix: 'idem' })

    expect(await s.get('k')).toBeUndefined()
    expect(await s.setPending('k')).toBe(true) // won the reservation
    expect(await s.get('k')).toBe('pending')

    const record = { status: 201, body: '{"id":1}', contentType: 'application/json' }
    await s.complete('k', record)
    expect(await s.get('k')).toEqual(record) // JSON round-trip, not the sentinel
  })

  it('release frees a reservation so the client can retry', async () => {
    const redis = fakeRedis()
    const s = new RedisIdempotencyStore(redis.client)
    await s.setPending('k')
    await s.release('k')
    expect(await s.get('k')).toBeUndefined()
  })

  it('prefixes keys and sends a PX ttl', async () => {
    const redis = fakeRedis()
    const s = new RedisIdempotencyStore(redis.client, { prefix: 'idem', ttlMs: 5000 })
    await s.setPending('k')
    expect(redis.setCalls[0]).toEqual(['idem:k', 'pending', 'PX', 5000, 'NX'])
  })

  it('reserves atomically with NX — a second setPending on a held key loses', async () => {
    const redis = fakeRedis()
    const s = new RedisIdempotencyStore(redis.client, { prefix: 'idem' })
    expect(await s.setPending('k')).toBe(true) // first caller wins
    expect(await s.setPending('k')).toBe(false) // key already held → rejected
    expect(await s.get('k')).toBe('pending') // still the original reservation
  })
})
