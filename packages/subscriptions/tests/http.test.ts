import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, route, type RequestEnricher } from '@basaltkit/fastify'
import {
  billingWebhookRoute,
  definePlans,
  FakeBillingGateway,
  SUBSCRIPTIONS,
  subscriptionsPlugin,
} from '../src/index.js'

const plans = definePlans({
  free: { price: 0, features: { api: false } },
  pro: { price: 29, features: { api: true } },
})

/** Test-only tenancy: trusts the x-tenant-id header. */
const fakeTenancyPlugin = definePlugin({
  name: 'fake-tenancy',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const tenantId = request.headers['x-tenant-id']
      if (typeof tenantId === 'string') context.tenant = { id: tenantId }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

const routes = (gateway: FakeBillingGateway) => [
  route({
    method: 'GET',
    url: '/reports',
    meta: { subscribed: 'pro' },
    async handler() {
      return { ok: true }
    },
  }),
  route({
    method: 'GET',
    url: '/api-data',
    meta: { feature: 'api' },
    async handler() {
      return { data: [] }
    },
  }),
  billingWebhookRoute(gateway),
]

const boot = async () => {
  const gateway = new FakeBillingGateway()
  const app = await createApp({
    plugins: [
      fakeTenancyPlugin,
      subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
      fastifyPlugin({ routes: routes(gateway) }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY), subscriptions: app.container.get(SUBSCRIPTIONS) }
}

describe('subscription guards over HTTP', () => {
  it('402 without the plan, 200 with it; feature guard 403 on free plan', async () => {
    const { app, server, subscriptions } = await boot()

    const noPlan = await server.inject({
      method: 'GET',
      url: '/reports',
      headers: { 'x-tenant-id': 'acme' },
    })
    expect(noPlan.statusCode).toBe(402)
    expect(noPlan.json().error.code).toBe('BILLING_SUBSCRIPTION_REQUIRED')

    const freeFeature = await server.inject({
      method: 'GET',
      url: '/api-data',
      headers: { 'x-tenant-id': 'acme' },
    })
    expect(freeFeature.statusCode).toBe(403)
    expect(freeFeature.json().error.code).toBe('BILLING_FEATURE_UNAVAILABLE')

    await subscriptions.subscribe('acme', 'pro')
    const withPlan = await server.inject({
      method: 'GET',
      url: '/reports',
      headers: { 'x-tenant-id': 'acme' },
    })
    expect(withPlan.json()).toEqual({ ok: true })

    const withFeature = await server.inject({
      method: 'GET',
      url: '/api-data',
      headers: { 'x-tenant-id': 'acme' },
    })
    expect(withFeature.json()).toEqual({ data: [] })

    // no tenant at all → 402 as well
    const central = await server.inject({ method: 'GET', url: '/reports' })
    expect(central.statusCode).toBe(402)
    await app.shutdown()
  })

  it('webhook endpoint: signature verified, idempotent, updates state', async () => {
    const { app, server, subscriptions } = await boot()
    await subscriptions.subscribe('acme', 'pro')

    const payload = { id: 'evt_9', type: 'payment.failed', billableId: 'acme' }
    const bad = await server.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'x-billing-signature': 'wrong' },
      payload,
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('BILLING_WEBHOOK_INVALID')

    const ok = await server.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'x-billing-signature': 'valid' },
      payload,
    })
    expect(ok.json()).toEqual({ received: true, duplicate: false })
    expect((await subscriptions.get('acme'))?.status).toBe('past_due')

    const retry = await server.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'x-billing-signature': 'valid' },
      payload,
    })
    expect(retry.json()).toEqual({ received: true, duplicate: true })
    await app.shutdown()
  })
})
