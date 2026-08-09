import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import { Cache, CACHE, cachePlugin, MemoryCacheDriver } from '../src/index.js'

const makeCache = (options = {}) => new Cache(new MemoryCacheDriver(), options)

describe('Cache (driver memory)', () => {
  it('put/get with fallback', async () => {
    const cache = makeCache()
    await cache.put('greeting', 'olá')
    expect(await cache.get('greeting')).toBe('olá')
    expect(await cache.get('missing', 'default')).toBe('default')
    expect(await cache.get('missing')).toBeUndefined()
  })

  describe('with a controlled clock', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('expires values by TTL', async () => {
      const cache = makeCache()
      await cache.put('session', 'abc', '30s')
      expect(await cache.get('session')).toBe('abc')
      vi.advanceTimersByTime(31_000)
      expect(await cache.get('session')).toBeUndefined()
    })
  })

  it('remember: computes once and deduplicates concurrent calls (stampede)', async () => {
    const cache = makeCache()
    let calls = 0
    const factory = async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 'caro'
    }
    const [a, b, c] = await Promise.all([
      cache.remember('expensive', '1h', factory),
      cache.remember('expensive', '1h', factory),
      cache.remember('expensive', '1h', factory),
    ])
    expect([a, b, c]).toEqual(['caro', 'caro', 'caro'])
    expect(calls).toBe(1)
    await cache.remember('expensive', '1h', factory)
    expect(calls).toBe(1) // now served from cache
  })

  it('tags: flush invalidates only the group', async () => {
    const cache = makeCache()
    await cache.tags('plans').put('plan:free', { price: 0 })
    await cache.tags('plans').put('plan:pro', { price: 29 })
    await cache.put('untagged', 'fica')

    await cache.tags('plans').flush()
    expect(await cache.get('plan:free')).toBeUndefined()
    expect(await cache.get('plan:pro')).toBeUndefined()
    expect(await cache.get('untagged')).toBe('fica')
  })

  it('automatic per-tenant isolation via context', async () => {
    const driver = new MemoryCacheDriver()
    const cache = new Cache(driver)

    await runWithContext({ tenant: { id: 'acme' } }, () => cache.put('config', 'da-acme'))
    await runWithContext({ tenant: { id: 'globex' } }, () => cache.put('config', 'da-globex'))
    await cache.put('config', 'central')

    expect(await runWithContext({ tenant: { id: 'acme' } }, () => cache.get('config'))).toBe(
      'da-acme',
    )
    expect(await runWithContext({ tenant: { id: 'globex' } }, () => cache.get('config'))).toBe(
      'da-globex',
    )
    expect(await cache.get('config')).toBe('central')

    // flushing a tenant does not affect the others
    await runWithContext({ tenant: { id: 'acme' } }, () => cache.flush())
    expect(
      await runWithContext({ tenant: { id: 'acme' } }, () => cache.get('config')),
    ).toBeUndefined()
    expect(await cache.get('config')).toBe('central')
  })

  it('cachePlugin registers the token and disconnects on shutdown', async () => {
    const app = await createApp({ plugins: [cachePlugin({ driver: 'memory' })] }).boot()
    const cache = app.container.get(CACHE)
    await cache.put('k', 'v')
    expect(await cache.get('k')).toBe('v')
    await app.shutdown()
  })

  it('cachePlugin accepts a custom CacheDriver instance', async () => {
    const driver = new MemoryCacheDriver()
    const app = await createApp({ plugins: [cachePlugin({ driver })] }).boot()
    await app.container.get(CACHE).put('k', 1)
    expect(await driver.get('basalt:k')).toBe(1) // wrote through the provided instance
    await app.shutdown()
  })
})
