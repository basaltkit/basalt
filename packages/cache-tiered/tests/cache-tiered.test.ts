import { describe, expect, it } from 'vitest'
import { MemoryCacheDriver, type CacheDriver } from '@basaltkit/cache'
import { TieredCacheDriver } from '../src/index.js'

/** Wraps a driver to count how often it is consulted. */
class SpyDriver implements CacheDriver {
  getCalls = 0
  constructor(private readonly inner: CacheDriver) {}
  async get(key: string): Promise<unknown> {
    this.getCalls++
    return this.inner.get(key)
  }
  set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void> {
    return this.inner.set(key, value, ttlMs, tags)
  }
  delete(key: string): Promise<boolean> {
    return this.inner.delete(key)
  }
  flushPrefix(prefix: string): Promise<void> {
    return this.inner.flushPrefix(prefix)
  }
  flushTags(tags: string[]): Promise<void> {
    return this.inner.flushTags(tags)
  }
  disconnect(): Promise<void> {
    return this.inner.disconnect()
  }
}

describe('TieredCacheDriver', () => {
  it('writes through to every layer', async () => {
    const near = new MemoryCacheDriver()
    const far = new MemoryCacheDriver()
    await new TieredCacheDriver({ layers: [near, far] }).set('k', 42)
    expect(await near.get('k')).toBe(42)
    expect(await far.get('k')).toBe(42)
  })

  it('a near-cache hit short-circuits the far layer', async () => {
    const near = new MemoryCacheDriver()
    const far = new SpyDriver(new MemoryCacheDriver())
    const tiered = new TieredCacheDriver({ layers: [near, far] })
    await tiered.set('k', 1)
    far.getCalls = 0
    expect(await tiered.get('k')).toBe(1)
    expect(far.getCalls).toBe(0) // far never consulted
  })

  it('backfills faster layers on a slow hit', async () => {
    const near = new MemoryCacheDriver()
    const far = new MemoryCacheDriver()
    await far.set('k', 'value') // only in the far layer
    const tiered = new TieredCacheDriver({ layers: [near, far] })

    expect(await tiered.get('k')).toBe('value')
    expect(await near.get('k')).toBe('value') // now cached near
  })

  it('returns undefined on a full miss', async () => {
    const tiered = new TieredCacheDriver({ layers: [new MemoryCacheDriver(), new MemoryCacheDriver()] })
    expect(await tiered.get('nope')).toBeUndefined()
  })

  it('deletes and invalidates by tag across all layers', async () => {
    const near = new MemoryCacheDriver()
    const far = new MemoryCacheDriver()
    const tiered = new TieredCacheDriver({ layers: [near, far] })

    await tiered.set('a', 1, undefined, ['t1'])
    await tiered.delete('a')
    expect(await near.get('a')).toBeUndefined()
    expect(await far.get('a')).toBeUndefined()

    await tiered.set('b', 2, undefined, ['t1'])
    await tiered.flushTags(['t1'])
    expect(await near.get('b')).toBeUndefined()
    expect(await far.get('b')).toBeUndefined()
  })

  it('rejects an empty layer list', () => {
    expect(() => new TieredCacheDriver({ layers: [] })).toThrow(/at least one layer/)
  })
})

describe('cross-replica staleness bound (backfillTtlMs clamps EVERY near-layer write)', () => {
  it('a replica does not serve its own stale L1 beyond backfillTtlMs after another replica updates', async () => {
    // Two replicas: separate near caches, one shared far cache.
    const far = new MemoryCacheDriver()
    const nearA = new MemoryCacheDriver()
    const nearB = new MemoryCacheDriver()
    const replicaA = new TieredCacheDriver({ layers: [nearA, far], backfillTtlMs: 30 })
    const replicaB = new TieredCacheDriver({ layers: [nearB, far], backfillTtlMs: 30 })

    // B writes with a LONG ttl — the near layer must still be clamped to 30ms.
    await replicaB.set('plan', 'v1', 60 * 60 * 1000)
    expect(await replicaB.get('plan')).toBe('v1')

    // A updates the shared value.
    await replicaA.set('plan', 'v2', 60 * 60 * 1000)

    // Within the bound B may serve v1 (documented near-cache staleness)...
    // ...but past backfillTtlMs B's near entry must expire and re-read the far cache.
    await new Promise((r) => setTimeout(r, 45))
    expect(await replicaB.get('plan')).toBe('v2')
  })

  it('the far (last) layer keeps the full TTL — the clamp applies only to near layers', async () => {
    const far = new MemoryCacheDriver()
    const near = new MemoryCacheDriver()
    const tiered = new TieredCacheDriver({ layers: [near, far], backfillTtlMs: 20 })
    await tiered.set('k', 'v', 10 * 60 * 1000)
    await new Promise((r) => setTimeout(r, 35))
    // Near expired (clamped), far still holds it: read backfills and serves.
    expect(await tiered.get('k')).toBe('v')
  })

  it('backfillTtlMs: null keeps the old behavior (no clamp, full TTL everywhere)', async () => {
    const far = new MemoryCacheDriver()
    const near = new MemoryCacheDriver()
    const tiered = new TieredCacheDriver({ layers: [near, far], backfillTtlMs: null })
    await tiered.set('k', 'v', 60_000)
    await new Promise((r) => setTimeout(r, 10))
    expect(await near.get('k')).toBe('v') // near still holds it — deliberate opt-out
  })
})
