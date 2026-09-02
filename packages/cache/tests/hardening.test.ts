import { describe, expect, it } from 'vitest'
import { Cache, MemoryCacheDriver } from '../src/index.js'

/**
 * The non-Redis half of the original hardening suite. Its Redis siblings moved
 * to @basaltkit/cache-redis with the driver they exercise; these two are about
 * the in-memory driver and the cache itself, so they stay with the core.
 */

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
})
