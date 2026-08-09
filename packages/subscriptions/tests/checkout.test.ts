import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin, type RequestEnricher } from '@basaltkit/fastify'
import {
  billingRoutes,
  definePlans,
  FakeBillingGateway,
  GatewayUnsupportedError,
  StripeBillingGateway,
  Subscriptions,
  subscriptionsPlugin,
} from '../src/index.js'

const plans = definePlans({
  free: { price: 0, features: { api: false } },
  pro: { price: 29, features: { api: true } },
  team: { price: 99, features: { api: true } },
})

describe('Checkout & Portal (service)', () => {
  it('checkout records an incomplete subscription and returns a URL', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })

    const { url } = await subs.checkout('acme', 'pro', {
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
    })
    expect(url).toContain('https://fake.test/checkout/')
    expect(gateway.checkouts[0]).toMatchObject({ billableId: 'acme', plan: 'pro', period: 'monthly' })

    // not active until the gateway confirms payment
    expect(await subs.subscribed('acme')).toBe(false)
    expect((await subs.get('acme'))?.status).toBe('incomplete')

    // webhook confirms payment and teaches us the gateway ref
    await subs.handleWebhook({ id: 'evt_1', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_live_1' })
    expect(await subs.subscribed('acme')).toBe(true)
    expect((await subs.get('acme'))?.gatewayRef).toBe('sub_live_1')
  })

  it('portal returns a management URL', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    const { url } = await subs.portal('acme', { returnUrl: 'https://app.test/account' })
    expect(url).toBe('https://fake.test/portal/acme')
    expect(gateway.portals[0]).toMatchObject({ billableId: 'acme', returnUrl: 'https://app.test/account' })
  })

  it('throws when the gateway cannot do checkout/portal', async () => {
    const subs = new Subscriptions({ plans }) // no gateway
    await expect(subs.checkout('acme', 'pro', { successUrl: 'x', cancelUrl: 'y' })).rejects.toBeInstanceOf(
      GatewayUnsupportedError,
    )
    await expect(subs.portal('acme', { returnUrl: 'x' })).rejects.toBeInstanceOf(GatewayUnsupportedError)
  })
})

describe('Plan swap with proration', () => {
  it('pushes the change to the gateway with proration by default', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.subscribe('acme', 'pro') // paid → gateway-backed, gets a gatewayRef

    await subs.swap('acme', 'team')
    expect(gateway.swaps[0]).toMatchObject({
      gatewayRef: 'fake_sub_1',
      input: { plan: 'team', period: 'monthly', prorationBehavior: 'create_prorations' },
    })
    expect((await subs.get('acme'))?.plan).toBe('team')
  })

  it('prorate:false switches without immediate settlement', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.subscribe('acme', 'pro')
    await subs.swap('acme', 'team', { prorate: false })
    expect(gateway.swaps[0]!.input.prorationBehavior).toBe('none')
  })
})

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

describe('Checkout & Portal (HTTP)', () => {
  it('exposes /billing/checkout and /billing/portal for the current tenant', async () => {
    const gateway = new FakeBillingGateway()
    const app = await createApp({
      plugins: [
        fakeTenancyPlugin,
        subscriptionsPlugin({ plans, gateway }),
        fastifyPlugin({
          routes: billingRoutes({ successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' }),
        }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    const headers = { 'x-tenant-id': 'acme' }

    const checkout = await server.inject({ method: 'POST', url: '/billing/checkout', headers, payload: { plan: 'pro' } })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().url).toContain('https://fake.test/checkout/')
    expect(gateway.checkouts[0]).toMatchObject({ successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' })

    const portal = await server.inject({ method: 'POST', url: '/billing/portal', headers, payload: {} })
    expect(portal.statusCode).toBe(200)
    expect(portal.json().url).toBe('https://fake.test/portal/acme')

    // no tenant → 402
    const anon = await server.inject({ method: 'POST', url: '/billing/checkout', payload: { plan: 'pro' } })
    expect(anon.statusCode).toBe(402)

    await app.shutdown()
  })
})

interface Recorded {
  url: string
  method: string
  body: string | undefined
}
function stripeGateway(handler: (call: Recorded) => Response) {
  const calls: Recorded[] = []
  const fetchMock: typeof fetch = async (url, init) => {
    const call: Recorded = { url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined }
    calls.push(call)
    return handler(call)
  }
  const gateway = new StripeBillingGateway({
    secretKey: 'sk_test',
    webhookSecret: 'whsec_test',
    priceId: (plan, period) => `price_${plan}_${period}`,
    customerId: (billableId) => `cus_${billableId}`,
    fetch: fetchMock,
    apiBase: 'https://api.stripe.test',
  })
  return { calls, gateway }
}
const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

describe('StripeBillingGateway — Checkout/Portal/proration', () => {
  it('createCheckoutSession posts a subscription-mode session', async () => {
    const { calls, gateway } = stripeGateway(() => ok({ id: 'cs_1', url: 'https://checkout.stripe/cs_1' }))
    const res = await gateway.createCheckoutSession({
      billableId: 'acme',
      plan: 'pro',
      period: 'monthly',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    })
    expect(res).toEqual({ id: 'cs_1', url: 'https://checkout.stripe/cs_1' })
    expect(calls[0]!.url).toBe('https://api.stripe.test/v1/checkout/sessions')
    expect(calls[0]!.body).toContain('mode=subscription')
    expect(calls[0]!.body).toContain('line_items%5B0%5D%5Bprice%5D=price_pro_monthly')
    expect(calls[0]!.body).toContain('subscription_data%5Bmetadata%5D%5BbillableId%5D=acme')
  })

  it('createPortalSession posts customer + return_url', async () => {
    const { calls, gateway } = stripeGateway(() => ok({ url: 'https://billing.stripe/p_1' }))
    const res = await gateway.createPortalSession({ billableId: 'acme', returnUrl: 'https://app/account' })
    expect(res.url).toBe('https://billing.stripe/p_1')
    expect(calls[0]!.url).toBe('https://api.stripe.test/v1/billing_portal/sessions')
    expect(calls[0]!.body).toContain('customer=cus_acme')
  })

  it('swapSubscription fetches the item then updates it with proration', async () => {
    const { calls, gateway } = stripeGateway((call) =>
      call.method === 'GET' ? ok({ items: { data: [{ id: 'si_1' }] } }) : ok({ id: 'sub_1' }),
    )
    await gateway.swapSubscription('sub_1', { plan: 'team', period: 'monthly' })
    expect(calls[0]!.method).toBe('GET')
    expect(calls[1]!.method).toBe('POST')
    expect(calls[1]!.body).toContain('items%5B0%5D%5Bid%5D=si_1')
    expect(calls[1]!.body).toContain('items%5B0%5D%5Bprice%5D=price_team_monthly')
    expect(calls[1]!.body).toContain('proration_behavior=create_prorations')
  })
})
