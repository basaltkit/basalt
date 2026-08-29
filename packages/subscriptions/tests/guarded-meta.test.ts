import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { UnguardedRouteMetaError } from '@basaltkit/http'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import { definePlans, FakeBillingGateway, subscriptionsPlugin } from '../src/index.js'

/**
 * `meta.subscribed` / `meta.feature` are paywall *requests* enforced by
 * subscriptionsPlugin's guard — exactly the class the adapters' boot-time
 * guarded-meta check exists to close. They were absent from GUARDED_META_KEYS
 * and unclaimed by the plugin, so a paywalled route with the plugin missing
 * booted happily and served the paid feature to everyone.
 */

const plans = definePlans({
  free: { price: 0, features: { api: false } },
  pro: { price: 29, features: { api: true } },
})

const paywalled = [
  route({ method: 'GET', url: '/reports', meta: { subscribed: 'pro' }, handler: () => ({ ok: true }) }),
  route({ method: 'GET', url: '/api-data', meta: { feature: 'api' }, handler: () => ({ ok: true }) }),
]

describe('paywall meta is part of the guarded-meta boot check', () => {
  it('refuses to boot when a route is paywalled but subscriptionsPlugin is absent', async () => {
    await expect(
      createApp({ plugins: [fastifyPlugin({ routes: paywalled })] }).boot(),
    ).rejects.toThrow(UnguardedRouteMetaError)
  })

  it('names both offending keys in the error', async () => {
    const error = await createApp({ plugins: [fastifyPlugin({ routes: paywalled })] })
      .boot()
      .catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(UnguardedRouteMetaError)
    const message = (error as Error).message
    expect(message).toContain('meta.subscribed')
    expect(message).toContain('meta.feature')
    expect(message).toContain('subscriptionsPlugin')
  })

  it('boots when subscriptionsPlugin is registered — it claims both keys', async () => {
    const app = await createApp({
      plugins: [
        subscriptionsPlugin({ plans, gateway: new FakeBillingGateway() }),
        fastifyPlugin({ routes: paywalled }),
      ],
    }).boot()
    expect(app).toBeDefined()
    await app.shutdown()
  })

  it('an explicit waiver still lets an edge-enforced deployment boot', async () => {
    const app = await createApp({
      plugins: [fastifyPlugin({ routes: paywalled, allowUnguardedMeta: ['subscribed', 'feature'] })],
    }).boot()
    expect(app).toBeDefined()
    await app.shutdown()
  })
})
