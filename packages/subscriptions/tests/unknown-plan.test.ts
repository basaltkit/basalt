import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import {
  definePlans,
  FakeBillingGateway,
  UnknownPlanMetaError,
  subscriptionsPlugin,
} from '../src/index.js'

/**
 * F-17 · A route gated on a plan that does not exist must not boot.
 *
 * The toolkit already refuses to boot a route declaring `meta.subscribed`
 * without `subscriptionsPlugin` — see `guarded-meta.test.ts`. It checked that
 * the *plugin* existed, never that the *value* meant anything.
 *
 * `Subscriptions.subscribed()` compares strings and returns false when they do
 * not match, and the guard turns that into a 402. So a route gated on a plan
 * absent from the catalogue is indistinguishable from one nobody subscribed to:
 * it answers 402 to every customer, forever, with nothing in the logs.
 *
 * Found by reading, not by failing — which is the point. In an application this
 * is a paid feature unreachable by everyone who paid for it.
 */
const plans = definePlans({
  free: { price: 0, features: { api: false } },
  pro: { price: 29, features: { api: true } },
})

const comPlanos = (rotas: ReturnType<typeof route>[]) =>
  createApp({
    plugins: [
      subscriptionsPlugin({ plans, gateway: new FakeBillingGateway() }),
      fastifyPlugin({ routes: rotas }),
    ],
  }).boot()

describe('F-17 · meta.subscribed is checked against the catalogue', () => {
  it('refuses to boot on a plan that is not in the catalogue', async () => {
    const rota = route({
      method: 'GET',
      url: '/reports',
      meta: { subscribed: 'enterprise' },
      handler: () => ({ ok: true }),
    })

    await expect(comPlanos([rota])).rejects.toThrow(UnknownPlanMetaError)
  })

  it('names the route, the plan, and what the catalogue has', async () => {
    // The error has to be actionable without opening the catalogue: the fix is
    // either a typo in one place or a plan missing from the other, and the
    // message should say which is which.
    const rota = route({
      method: 'GET',
      url: '/reports',
      meta: { subscribed: 'pró' },
      handler: () => ({ ok: true }),
    })

    const erro = await comPlanos([rota]).catch((e: unknown) => e as Error)
    expect(erro.message).toContain('/reports')
    expect(erro.message).toContain('pró')
    expect(erro.message).toContain('free')
    expect(erro.message).toContain('pro')
  })

  it('boots on a plan that exists', async () => {
    const rota = route({
      method: 'GET',
      url: '/reports',
      meta: { subscribed: 'pro' },
      handler: () => ({ ok: true }),
    })

    const app = await comPlanos([rota])
    expect(app).toBeDefined()
    await app.shutdown()
  })

  it('reports every offending route at once', async () => {
    // Booting, failing, fixing one, booting again is a slow way to find three.
    const rotas = [
      route({ method: 'GET', url: '/a', meta: { subscribed: 'enterprise' }, handler: () => ({}) }),
      route({ method: 'GET', url: '/b', meta: { subscribed: 'pro' }, handler: () => ({}) }),
      route({ method: 'GET', url: '/c', meta: { subscribed: 'starter' }, handler: () => ({}) }),
    ]

    const erro = await comPlanos(rotas).catch((e: unknown) => e as Error)
    expect(erro.message).toContain('/a')
    expect(erro.message).toContain('/c')
    expect(erro.message).not.toContain('/b')
  })

  it('leaves routes without meta.subscribed alone', async () => {
    const rotas = [
      route({ method: 'GET', url: '/livre', handler: () => ({}) }),
      route({ method: 'GET', url: '/feature', meta: { feature: 'api' }, handler: () => ({}) }),
    ]

    const app = await comPlanos(rotas)
    expect(app).toBeDefined()
    await app.shutdown()
  })
})
