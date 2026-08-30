import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { Cache, CACHE, cachePlugin, MemoryCacheDriver, MissingCacheScopeError } from '../src/index.js'

const makeCache = (options = {}) => new Cache(new MemoryCacheDriver(), options)

describe('Cache — tenant-scope safety', () => {
  it('flush() fails closed when no tenant scope resolves in a MULTI-TENANT app', async () => {
    const cache = new Cache(new MemoryCacheDriver(), {}, () => true) // tenancy active
    await expect(cache.flush()).rejects.toBeInstanceOf(MissingCacheScopeError)
    // a deliberate global cache (scope:null) may flush its whole namespace
    await expect(new Cache(new MemoryCacheDriver(), { scope: null }, () => true).flush()).resolves.toBeUndefined()
    // and a properly-scoped flush works
    await runWithContext({ tenant: { id: 'acme' } }, () => cache.flush())
  })

  it("flush() also fails closed on an explicit onMissingScope:'error', tenancy or not", async () => {
    await expect(makeCache({ onMissingScope: 'error' }).flush()).rejects.toBeInstanceOf(MissingCacheScopeError)
  })

  it('beyond-SaaS: with NO tenancy, flush() clears this app\'s own namespace instead of throwing', async () => {
    const cache = makeCache() // single-tenant app: nothing to cross
    await cache.put('k', 'v')
    await expect(cache.flush()).resolves.toBeUndefined()
    expect(await cache.get('k')).toBeUndefined()
  })

  it('beyond-SaaS: cachePlugin without tenancy leaves flush() open, with tenancy closed', async () => {
    const single = await createApp({ plugins: [cachePlugin({ driver: 'memory' })] }).boot()
    await expect(single.container.get(CACHE).flush()).resolves.toBeUndefined()
    await single.shutdown()

    const marker = definePlugin({
      name: 'fake-tenancy-marker',
      register({ container }) {
        ensureMetadata(container).add('tenancy:active', true)
      },
    })
    const multi = await createApp({ plugins: [marker, cachePlugin({ driver: 'memory' })] }).boot()
    await expect(multi.container.get(CACHE).flush()).rejects.toBeInstanceOf(MissingCacheScopeError)
    await multi.shutdown()
  })

  it("onMissingScope:'error' fails closed on read/write without a tenant", async () => {
    const cache = makeCache({ onMissingScope: 'error' })
    await expect(cache.put('k', 'v')).rejects.toBeInstanceOf(MissingCacheScopeError)
    await expect(cache.get('k')).rejects.toBeInstanceOf(MissingCacheScopeError)
    // with a tenant in context it works and is isolated
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      await cache.put('k', 'v')
      expect(await cache.get('k')).toBe('v')
    })
    // a different tenant does not see it
    await runWithContext({ tenant: { id: 'globex' } }, async () => {
      expect(await cache.get('k')).toBeUndefined()
    })
  })
})

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

describe('tenancy-aware onMissingScope default (fail closed when tenancy is active)', () => {
  /** Simulates @basaltkit/tenancy's presence via its metadata marker. */
  const fakeTenancyMarker = definePlugin({
    name: 'fake-tenancy-marker',
    register({ container }) {
      ensureMetadata(container).add('tenancy:active', true)
    },
  })

  it('with tenancy active, an operation OUTSIDE tenant context throws MissingCacheScopeError', async () => {
    const app = await createApp({ plugins: [fakeTenancyMarker, cachePlugin({ driver: 'memory' })] }).boot()
    const cache = app.container.get(CACHE)
    await expect(cache.put('plan-limits', { max: 5 })).rejects.toBeInstanceOf(MissingCacheScopeError)
    await expect(cache.get('plan-limits')).rejects.toBeInstanceOf(MissingCacheScopeError)
    await app.shutdown()
  })

  it('with tenancy active, operations INSIDE tenant context still work (scoped)', async () => {
    const app = await createApp({ plugins: [fakeTenancyMarker, cachePlugin({ driver: 'memory' })] }).boot()
    const cache = app.container.get(CACHE)
    await runWithContext({ tenant: { id: 't1' } } as never, async () => {
      await cache.put('k', 'v')
      expect(await cache.get('k')).toBe('v')
    })
    await app.shutdown()
  })

  it('without tenancy, the global namespace keeps working (single-tenant apps unaffected)', async () => {
    const app = await createApp({ plugins: [cachePlugin({ driver: 'memory' })] }).boot()
    const cache = app.container.get(CACHE)
    await cache.put('k', 'v')
    expect(await cache.get('k')).toBe('v')
    await app.shutdown()
  })

  it("an explicit onMissingScope: 'global' opts out even with tenancy active", async () => {
    const app = await createApp({
      plugins: [fakeTenancyMarker, cachePlugin({ driver: 'memory', onMissingScope: 'global' })],
    }).boot()
    const cache = app.container.get(CACHE)
    await cache.put('k', 'v')
    expect(await cache.get('k')).toBe('v')
    await app.shutdown()
  })

  it('a custom scope function is left alone (the caller owns its semantics)', async () => {
    const app = await createApp({
      plugins: [fakeTenancyMarker, cachePlugin({ driver: 'memory', scope: () => undefined })],
    }).boot()
    const cache = app.container.get(CACHE)
    await cache.put('k', 'v') // custom scope → historic 'global' default stands
    expect(await cache.get('k')).toBe('v')
    await app.shutdown()
  })
})
