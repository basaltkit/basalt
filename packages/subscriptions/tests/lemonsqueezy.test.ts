import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  LemonSqueezyBillingGateway,
  LemonSqueezyRequestError,
  WebhookInvalidError,
} from '../src/index.js'

const WEBHOOK_SECRET = 'ls_test_secret'

/** Lemon Squeezy signs with a bare HMAC-SHA256 hex of the raw body (no timestamp). */
function lsSignature(rawBody: string, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function harness(handler: (call: Recorded) => Response) {
  const calls: Recorded[] = []
  const fetchMock: typeof fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    })
    return handler(calls[calls.length - 1] as Recorded)
  }
  return { calls, fetchMock }
}

const data = (d: unknown, status = 200) =>
  new Response(JSON.stringify({ data: d }), { status, headers: { 'content-type': 'application/vnd.api+json' } })

function makeGateway(fetchMock: typeof fetch) {
  return new LemonSqueezyBillingGateway({
    apiKey: 'ls_key',
    webhookSecret: WEBHOOK_SECRET,
    storeId: '42',
    variantId: (plan, period) => `var_${plan}_${period}`,
    customerId: (billableId) => `cus_${billableId}`,
    fetch: fetchMock,
  })
}

describe('LemonSqueezyBillingGateway — API calls', () => {
  it('createSubscription creates a JSON:API checkout with the variant, store and custom data', async () => {
    const { calls, fetchMock } = harness(() => data({ id: 'chk_1', attributes: { url: 'https://x/checkout' } }))
    const res = await makeGateway(fetchMock).createSubscription({
      billableId: 'acme',
      plan: 'pro',
      period: 'monthly',
      price: 2900,
    })
    expect(res).toEqual({ gatewayRef: 'chk_1' })
    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/checkouts')
    expect(calls[0]!.headers.accept).toBe('application/vnd.api+json')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.data.type).toBe('checkouts')
    expect(body.data.attributes.checkout_data.custom).toEqual({ billableId: 'acme' })
    expect(body.data.relationships.store.data.id).toBe('42')
    expect(body.data.relationships.variant.data.id).toBe('var_pro_monthly')
  })

  it('createCheckoutSession returns the checkout url and sets the redirect', async () => {
    const { calls, fetchMock } = harness(() => data({ id: 'chk_2', attributes: { url: 'https://x/checkout2' } }))
    const res = await makeGateway(fetchMock).createCheckoutSession({
      billableId: 'acme',
      plan: 'pro',
      period: 'yearly',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    })
    expect(res).toEqual({ url: 'https://x/checkout2', id: 'chk_2' })
    expect(JSON.parse(calls[0]!.body!).data.attributes.product_options.redirect_url).toBe('https://app/ok')
  })

  it('cancelSubscription DELETEs the subscription', async () => {
    const { calls, fetchMock } = harness(() => data({}))
    await makeGateway(fetchMock).cancelSubscription('sub_1', { atPeriodEnd: true })
    expect(calls[0]!.method).toBe('DELETE')
    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/sub_1')
  })

  it('createPortalSession reads the customer_portal url from the customer', async () => {
    const { calls, fetchMock } = harness(() =>
      data({ attributes: { urls: { customer_portal: 'https://store.lemonsqueezy.com/billing?x' } } }),
    )
    const res = await makeGateway(fetchMock).createPortalSession({ billableId: 'acme', returnUrl: 'https://app' })
    expect(res).toEqual({ url: 'https://store.lemonsqueezy.com/billing?x' })
    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/customers/cus_acme')
  })

  it('swapSubscription PATCHes the variant with the mapped proration flags', async () => {
    const none = harness(() => data({}))
    await makeGateway(none.fetchMock).swapSubscription('sub_1', { plan: 'team', period: 'monthly', prorationBehavior: 'none' })
    let attrs = JSON.parse(none.calls[0]!.body!).data.attributes
    expect(none.calls[0]!.method).toBe('PATCH')
    expect(attrs.variant_id).toBe('var_team_monthly')
    expect(attrs.disable_prorations).toBe(true)

    const inv = harness(() => data({}))
    await makeGateway(inv.fetchMock).swapSubscription('sub_1', { plan: 'team', period: 'monthly', prorationBehavior: 'always_invoice' })
    attrs = JSON.parse(inv.calls[0]!.body!).data.attributes
    expect(attrs.disable_prorations).toBe(false)
    expect(attrs.invoice_immediately).toBe(true)
  })

  it('throws LemonSqueezyRequestError on a non-2xx', async () => {
    const { fetchMock } = harness(
      () => new Response(JSON.stringify({ errors: [{ detail: 'invalid variant' }] }), { status: 422 }),
    )
    await expect(
      makeGateway(fetchMock).createSubscription({ billableId: 'a', plan: 'p', period: 'monthly', price: 1 }),
    ).rejects.toBeInstanceOf(LemonSqueezyRequestError)
  })
})

describe('LemonSqueezyBillingGateway — verifyWebhook', () => {
  const gw = makeGateway((async () => new Response('{}')) as typeof fetch)

  it('verifies a signed subscription_payment_success → payment.succeeded', () => {
    const raw = JSON.stringify({
      meta: { event_name: 'subscription_payment_success', custom_data: { billableId: 'acme' } },
      data: { id: 'inv_1', attributes: { subscription_id: 77 } },
    })
    expect(gw.verifyWebhook(raw, lsSignature(raw))).toMatchObject({
      type: 'payment.succeeded',
      billableId: 'acme',
      gatewayRef: '77',
    })
  })

  it('maps subscription_cancelled and reads the ref from data.id', () => {
    const raw = JSON.stringify({
      meta: { event_name: 'subscription_cancelled', custom_data: { billableId: 'acme' } },
      data: { id: 'sub_9' },
    })
    expect(gw.verifyWebhook(raw, lsSignature(raw))).toMatchObject({
      type: 'subscription.canceled',
      gatewayRef: 'sub_9',
    })
  })

  it('returns null for a verified but unmapped event', () => {
    const raw = JSON.stringify({ meta: { event_name: 'order_created', custom_data: { billableId: 'a' } }, data: { id: 'o1' } })
    expect(gw.verifyWebhook(raw, lsSignature(raw))).toBeNull()
  })

  it('rejects a bad or missing signature', () => {
    const raw = JSON.stringify({ meta: { event_name: 'subscription_cancelled', custom_data: { billableId: 'a' } }, data: { id: 's' } })
    expect(() => gw.verifyWebhook(raw, undefined)).toThrow(WebhookInvalidError)
    expect(() => gw.verifyWebhook(raw, lsSignature(raw, 'wrong'))).toThrow(WebhookInvalidError)
  })
})
