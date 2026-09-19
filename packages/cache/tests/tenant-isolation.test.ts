import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata, runWithContext } from '@basaltkit/core'
import { CACHE, Cache, cachePlugin, MemoryCacheDriver, MissingCacheScopeError } from '../src/index.js'

const as = <T>(id: string, fn: () => Promise<T>) => runWithContext({ tenant: { id } }, fn)

describe('security: cache tenant namespaces cannot collide through the tenant id', () => {
  it("a tenant id containing ':' cannot read or poison another tenant's keys", async () => {
    const cache = new Cache(new MemoryCacheDriver())
    await as('globex', () => cache.put('user:42', { role: 'owner' }))

    // 'globex:user' + '42' must not address globex's 'user:42'
    expect(await as('globex:user', () => cache.get('42'))).toBeUndefined()

    await as('globex:user', () => cache.put('42', { role: 'attacker' }))
    expect(await as('globex', () => cache.get('user:42'))).toEqual({ role: 'owner' })
  })

  it('a tenant flush cannot wipe a prefix-sharing tenant', async () => {
    const cache = new Cache(new MemoryCacheDriver())
    await as('globex', () => cache.put('user:1', 'kept'))
    await as('globex:user', () => cache.flush())
    expect(await as('globex', () => cache.get('user:1'))).toBe('kept')
  })

  it('an encoded-looking tenant id does not alias a decoded one', async () => {
    const cache = new Cache(new MemoryCacheDriver())
    await as('globex', () => cache.put('user:9', 'secret'))
    expect(await as('globex%3Auser', () => cache.get('9'))).toBeUndefined()
    expect(await as('globex%3auser', () => cache.get('9'))).toBeUndefined()
  })

  it('ordinary tenant ids keep their existing key layout', async () => {
    const driver = new MemoryCacheDriver()
    const cache = new Cache(driver)
    await as('acme', () => cache.put('k', 1))
    expect(await driver.get('basalt:tenant:acme:k')).toBe(1)
  })
})

describe('security: the fail-closed default does not depend on plugin order', () => {
  const fakeTenancy = definePlugin({
    name: 'test:tenancy-marker',
    register({ container }) {
      ensureMetadata(container).add('tenancy:active', true)
    },
  })

  it('a cache resolved before tenancy registers still refuses to run without a tenant', async () => {
    // A plugin that resolves the cache eagerly in its own register(), listed
    // before tenancy: the marker is not there yet at that moment, but the app
    // IS multi-tenant by the time any request runs.
    let early: Cache | undefined
    const eager = definePlugin({
      name: 'test:eager-cache-consumer',
      register({ container }) {
        early = container.get(CACHE)
      },
    })
    const app = await createApp({ plugins: [cachePlugin(), eager, fakeTenancy] }).boot()
    const cache = app.container.get(CACHE)
    expect(cache).toBe(early)
    await as('acme', () => cache.put('user:42', { role: 'owner' }))

    // Without a tenant the key must not resolve against the shared global
    // namespace, where 'tenant:acme:user:42' IS acme's 'user:42'.
    await expect(runWithContext({}, () => cache.get('tenant:acme:user:42'))).rejects.toBeInstanceOf(MissingCacheScopeError)
    await expect(runWithContext({}, () => cache.put('tenant:acme:user:42', { role: 'attacker' }))).rejects.toBeInstanceOf(
      MissingCacheScopeError,
    )
    expect(await as('acme', () => cache.get('user:42'))).toEqual({ role: 'owner' })
  })
})
