import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, HttpError, type RequestEnricher, type RouteGuard } from '@basaltkit/fastify'
import {
  billingRoutes,
  billingWebhookRoute,
  definePlans,
  FakeBillingGateway,
  invoiceRoutes,
  subscriptionsPlugin,
} from '../src/index.js'

/**
 * S-1 (ecosystem review 2026-08-b): billing/invoice routes are secure by
 * default — `meta: { auth: true }` unless explicitly opted out — while the
 * webhook route stays signature-authenticated (no session auth, by design).
 */

const plans = definePlans({ pro: { price: 29, features: { api: true } } })
const urls = { successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' }

const fakeTenancyPlugin = definePlugin({
  name: 'fake-tenancy',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      const id = request.headers['x-tenant-id']
      if (typeof id === 'string') context.tenant = { id }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
  },
})

/** Auth-style guard exactly like @basaltkit/auth's: rejects meta.auth without a user. */
const fakeAuthPlugin = definePlugin({
  name: 'fake-auth',
  register({ container }) {
    const enricher: RequestEnricher = ({ request, context }) => {
      if (request.headers['authorization'] === 'Bearer good') context.user = { id: 'u1' }
    }
    const guard: RouteGuard = ({ route, context }) => {
      if (route.meta?.['auth'] && !context.user) {
        throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required.')
      }
    }
    ensureMetadata(container).add('http:enrichers', enricher)
    const metadata = ensureMetadata(container)
    metadata.add('http:guards', guard)
    metadata.add('http:guarded-meta', 'auth') // enforces meta.auth — claim it for the boot check
  },
})

const bootApp = async (routes: unknown[]) => {
  const gateway = new FakeBillingGateway()
  const app = await createApp({
    plugins: [
      fakeTenancyPlugin,
      fakeAuthPlugin,
      subscriptionsPlugin({ plans, gateway }),
      fastifyPlugin({ routes: routes as never }),
    ],
  }).boot()
  return { server: app.container.get(FASTIFY), gateway, app }
}

describe('billingRoutes are authenticated by default', () => {
  it('unauthenticated checkout/portal → 401, even with a resolved tenant', async () => {
    const { server } = await bootApp(billingRoutes(urls))
    const headers = { 'x-tenant-id': 'acme' } // tenant resolved, NO user
    const checkout = await server.inject({ method: 'POST', url: '/billing/checkout', headers, payload: { plan: 'pro' } })
    expect(checkout.statusCode).toBe(401)
    expect(checkout.json().error.code).toBe('AUTH_REQUIRED')
    const portal = await server.inject({ method: 'POST', url: '/billing/portal', headers, payload: {} })
    expect(portal.statusCode).toBe(401)
  })

  it('authenticated checkout/portal work as before', async () => {
    const { server } = await bootApp(billingRoutes(urls))
    const headers = { 'x-tenant-id': 'acme', authorization: 'Bearer good' }
    const checkout = await server.inject({ method: 'POST', url: '/billing/checkout', headers, payload: { plan: 'pro' } })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().url).toContain('https://fake.test/checkout/')
    const portal = await server.inject({ method: 'POST', url: '/billing/portal', headers, payload: {} })
    expect(portal.statusCode).toBe(200)
  })

  it('auth: false is a deliberate opt-out (edge-authenticated deployments)', async () => {
    const { server } = await bootApp(billingRoutes({ ...urls, auth: false }))
    const checkout = await server.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: { 'x-tenant-id': 'acme' },
      payload: { plan: 'pro' },
    })
    expect(checkout.statusCode).toBe(200)
  })
})

describe('invoiceRoutes are authenticated by default', () => {
  it('unauthenticated invoice list/detail/html → 401', async () => {
    const { server } = await bootApp(invoiceRoutes())
    const headers = { 'x-tenant-id': 'acme' }
    for (const url of ['/billing/invoices', '/billing/invoices/inv_1', '/billing/invoices/inv_1/html']) {
      const res = await server.inject({ method: 'GET', url, headers })
      expect(res.statusCode, url).toBe(401)
    }
  })

  it('authenticated invoice list works', async () => {
    const { server } = await bootApp(invoiceRoutes())
    const res = await server.inject({
      method: 'GET',
      url: '/billing/invoices',
      headers: { 'x-tenant-id': 'acme', authorization: 'Bearer good' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('the webhook route stays signature-authenticated only', () => {
  it('has no meta.auth (session auth would break gateway callbacks) and still verifies signatures', async () => {
    const gateway = new FakeBillingGateway()
    const [webhook] = [billingWebhookRoute(gateway)]
    expect(webhook!.meta?.['auth']).toBeUndefined()

    const { server } = await bootApp([billingWebhookRoute(gateway)])
    // No authorization header — the auth guard must NOT reject it (no 401);
    // the gateway's SIGNATURE verification is the authenticator and fails
    // closed on a forged body.
    const forged = await server.inject({
      method: 'POST',
      url: '/billing/webhook',
      payload: { forged: true },
    })
    expect(forged.statusCode).toBe(400) // WebhookInvalidError — not 401
    expect(forged.json().error.code).not.toBe('AUTH_REQUIRED')

    const signed = await server.inject({
      method: 'POST',
      url: '/billing/webhook',
      headers: { 'x-billing-signature': 'valid' },
      payload: { id: 'evt_ok', type: 'payment.succeeded', billableId: 'acme' },
    })
    expect(signed.statusCode).toBe(200)
    expect(signed.json()).toMatchObject({ received: true })
  })
})
