import { describe, expect, it } from 'vitest'
import { Cache, MemoryCacheDriver } from '../src/index.js'

/** Controllable clock so the fresh/stale/expired windows are deterministic. */
function fakeClock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('stale-while-revalidate', () => {
  it('serves fresh from cache without calling the factory again', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    let calls = 0
    const load = () => {
      calls++
      return `v${calls}`
    }
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v1')
    clock.advance(30_000) // still within ttl
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v1')
    expect(calls).toBe(1)
  })

  it('serves stale immediately and refreshes in the background', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    let calls = 0
    const load = () => {
      calls++
      return `v${calls}`
    }
    await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load) // v1
    clock.advance(90_000) // past ttl (60s), within stale window (360s)

    // returns the STALE value right away…
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v1')
    // …and a background refresh ran exactly once
    await flush()
    expect(calls).toBe(2)
    // next read (still fresh vs the new clock baseline) is the refreshed value
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v2')
    expect(calls).toBe(2)
  })

  it('dedupes concurrent stale reads into a single background refresh', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    let calls = 0
    const load = async () => {
      calls++
      await Promise.resolve()
      return `v${calls}`
    }
    await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)
    clock.advance(90_000)
    const [a, b, c] = await Promise.all([
      cache.remember('k', { ttl: '1m', staleFor: '5m' }, load),
      cache.remember('k', { ttl: '1m', staleFor: '5m' }, load),
      cache.remember('k', { ttl: '1m', staleFor: '5m' }, load),
    ])
    expect([a, b, c]).toEqual(['v1', 'v1', 'v1']) // all stale
    await flush()
    expect(calls).toBe(2) // 1 initial + 1 background refresh (deduped)
  })

  it('blocks and recomputes once the stale window has passed (hard expiry)', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    let calls = 0
    const load = () => {
      calls++
      return `v${calls}`
    }
    await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load) // v1
    clock.advance(7 * 60_000) // past ttl + staleFor (6m)
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v2')
    expect(calls).toBe(2)
  })

  it('keeps serving stale when the background refresh throws', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    let calls = 0
    const load = () => {
      calls++
      if (calls === 2) throw new Error('upstream down')
      return `v${calls}`
    }
    await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)
    clock.advance(90_000)
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v1') // stale served
    await flush()
    // failed refresh didn't poison the entry — still serves stale, tries again
    expect(await cache.remember('k', { ttl: '1m', staleFor: '5m' }, load)).toBe('v1')
  })

  it('plain get() transparently unwraps an SWR entry', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    await cache.remember('k', { ttl: '1m', staleFor: '5m' }, () => ({ hello: 'world' }))
    expect(await cache.get('k')).toEqual({ hello: 'world' })
  })

  it('SWR works through tags() and the tag flush clears it', async () => {
    const clock = fakeClock()
    const cache = new Cache(new MemoryCacheDriver(), { scope: null, now: clock.now })
    let calls = 0
    const load = () => `v${++calls}`
    await cache.tags('plans').remember('k', { ttl: '1m', staleFor: '5m' }, load)
    await cache.tags('plans').flush()
    expect(await cache.get('k')).toBeUndefined()
  })
})
