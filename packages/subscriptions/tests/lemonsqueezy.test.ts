import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CheckoutRequiredError,
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
  // FA-054 (S-6): a checkout id is not a subscription — returning it as the
  // gatewayRef activated the plan unpaid and broke cancel()/swap().
  it('createSubscription refuses (checkout-first) and makes no API call', async () => {
    const { calls, fetchMock } = harness(() => data({ id: 'chk_1', attributes: { url: 'https://x/checkout' } }))
    await expect(
      makeGateway(fetchMock).createSubscription({ billableId: 'acme', plan: 'pro', period: 'monthly', price: 2900 }),
    ).rejects.toBeInstanceOf(CheckoutRequiredError)
    expect(calls).toHaveLength(0)
  })

  it('createCheckoutSession sends the variant, store and custom data', async () => {
    const { calls, fetchMock } = harness(() => data({ id: 'chk_1', attributes: { url: 'https://x/checkout' } }))
    await makeGateway(fetchMock).createCheckoutSession({
      billableId: 'acme',
      plan: 'pro',
      period: 'monthly',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    })
    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/checkouts')
    expect(calls[0]!.headers.accept).toBe('application/vnd.api+json')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.data.type).toBe('checkouts')
    expect(body.data.attributes.checkout_data.custom).toEqual({ billableId: 'acme', plan: 'pro', period: 'monthly' })
    expect(body.data.relationships.store.data.id).toBe('42')
    expect(body.data.relationships.variant.data.id).toBe('var_pro_monthly')
  })

  it('resumeSubscription un-cancels the subscription', async () => {
    const { calls, fetchMock } = harness(() => data({}))
    await makeGateway(fetchMock).resumeSubscription('sub_1')
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url).toBe('https://api.lemonsqueezy.com/v1/subscriptions/sub_1')
    expect(JSON.parse(calls[0]!.body!).data.attributes).toEqual({ cancelled: false })
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
      makeGateway(fetchMock).createCheckoutSession({
        billableId: 'a',
        plan: 'p',
        period: 'monthly',
        successUrl: 'https://app/ok',
        cancelUrl: 'https://app/no',
      }),
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

  // FA-052 (S-4): the idempotency key was `${event}:${subscriptionId}`, so the
  // SECOND renewal of a subscription had the same key as the first and was
  // dropped as a duplicate — the customer paid and the app never saw it.
  it('gives every renewal its own idempotency key (and a re-delivery the same one)', () => {
    const renewal = (invoiceId: string, at: string) =>
      JSON.stringify({
        meta: { event_name: 'subscription_payment_success', custom_data: { billableId: 'acme' } },
        data: { type: 'subscription-invoices', id: invoiceId, attributes: { subscription_id: 77, updated_at: at } },
      })
    const first = renewal('inv_1', '2026-08-01T00:00:00Z')
    const second = renewal('inv_2', '2026-09-01T00:00:00Z')
    const a = gw.verifyWebhook(first, lsSignature(first))!
    const b = gw.verifyWebhook(second, lsSignature(second))!
    expect(a.gatewayRef).toBe('77')
    expect(b.gatewayRef).toBe('77')
    expect(a.id).not.toBe(b.id)
    // the same delivery again → the same key (dedupe still works)
    expect(gw.verifyWebhook(first, lsSignature(first))!.id).toBe(a.id)
  })

  it('a second cancel after a resume is not a duplicate of the first', () => {
    const cancel = (at: string) =>
      JSON.stringify({
        meta: { event_name: 'subscription_cancelled', custom_data: { billableId: 'acme' } },
        data: { type: 'subscriptions', id: 'sub_9', attributes: { updated_at: at } },
      })
    const one = cancel('2026-08-01T00:00:00Z')
    const two = cancel('2026-08-20T00:00:00Z')
    expect(gw.verifyWebhook(one, lsSignature(one))!.id).not.toBe(gw.verifyWebhook(two, lsSignature(two))!.id)
  })

  it('declares x-signature as its signature header', () => {
    expect(gw.signatureHeader).toBe('x-signature')
  })

  // S-12: LS signs the body only (no timestamp) — an opt-in replay window.
  it('maxEventAgeSeconds rejects stale or undated events', () => {
    const now = Date.parse('2026-09-01T00:10:00Z')
    const strict = new LemonSqueezyBillingGateway({
      apiKey: 'k',
      webhookSecret: WEBHOOK_SECRET,
      storeId: '1',
      variantId: () => 'v',
      maxEventAgeSeconds: 3600,
      now: () => now,
    })
    const body = (at?: string) =>
      JSON.stringify({
        meta: { event_name: 'subscription_payment_success', custom_data: { billableId: 'acme' } },
        data: { id: 'inv_1', attributes: { subscription_id: 77, ...(at ? { updated_at: at } : {}) } },
      })
    const fresh = body('2026-09-01T00:00:00Z')
    expect(strict.verifyWebhook(fresh, lsSignature(fresh))).toMatchObject({ type: 'payment.succeeded' })
    const stale = body('2026-08-01T00:00:00Z')
    expect(() => strict.verifyWebhook(stale, lsSignature(stale))).toThrow(WebhookInvalidError)
    const undated = body()
    expect(() => strict.verifyWebhook(undated, lsSignature(undated))).toThrow(WebhookInvalidError)
    // default (off): an old event still verifies
    expect(gw.verifyWebhook(stale, lsSignature(stale))).toMatchObject({ type: 'payment.succeeded' })
  })
})
