import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  definePlans,
  StripeBillingGateway,
  StripeRequestError,
  Subscriptions,
  WebhookInvalidError,
} from '../src/index.js'

const WEBHOOK_SECRET = 'whsec_test'
const NOW_MS = 1_700_000_000_000 // fixed clock

/** Signs a raw body the way Stripe does: HMAC-SHA256 over `${t}.${body}`. */
function stripeSignature(rawBody: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(NOW_MS / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return `t=${timestamp},v1=${signature}`
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

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

function makeGateway(fetchMock: typeof fetch) {
  return new StripeBillingGateway({
    secretKey: 'sk_test_123',
    webhookSecret: WEBHOOK_SECRET,
    priceId: (plan, period) => `price_${plan}_${period}`,
    customerId: (billableId) => `cus_${billableId}`,
    fetch: fetchMock,
    now: () => NOW_MS,
    apiBase: 'https://api.stripe.test',
  })
}

describe('StripeBillingGateway — REST calls', () => {
  it('createSubscription posts customer, price and billable metadata', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ id: 'sub_123' }))
    const gateway = makeGateway(fetchMock)

    const result = await gateway.createSubscription({
      billableId: 'acme',
      plan: 'pro',
      period: 'monthly',
      price: 29,
    })

    expect(result).toEqual({ gatewayRef: 'sub_123' })
    expect(calls[0]?.url).toBe('https://api.stripe.test/v1/subscriptions')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk_test_123')
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(calls[0]?.body)
    expect(body.get('customer')).toBe('cus_acme')
    expect(body.get('items[0][price]')).toBe('price_pro_monthly')
    expect(body.get('metadata[billableId]')).toBe('acme')
    expect(body.get('trial_period_days')).toBeNull() // no trial on this call
  })

  it('createSubscription passes trial_period_days when a trial is requested', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ id: 'sub_456' }))
    const gateway = makeGateway(fetchMock)

    await gateway.createSubscription({
      billableId: 'acme',
      plan: 'pro',
      period: 'monthly',
      price: 29,
      trialDays: 14,
    })
    expect(new URLSearchParams(calls[0]?.body).get('trial_period_days')).toBe('14')
  })

  it('cancelSubscription updates at period end vs deletes immediately', async () => {
    const { calls, fetchMock } = harness(() => jsonResponse({ id: 'sub_123', status: 'canceled' }))
    const gateway = makeGateway(fetchMock)

    await gateway.cancelSubscription('sub_123', { atPeriodEnd: true })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe('https://api.stripe.test/v1/subscriptions/sub_123')
    expect(new URLSearchParams(calls[0]?.body).get('cancel_at_period_end')).toBe('true')

    await gateway.cancelSubscription('sub_123', { atPeriodEnd: false })
    expect(calls[1]?.method).toBe('DELETE')
    expect(calls[1]?.body).toBeUndefined()
  })

  it('surfaces Stripe API errors', async () => {
    const { fetchMock } = harness(() => jsonResponse({ error: { message: 'No such customer' } }, 404))
    const gateway = makeGateway(fetchMock)
    await expect(
      gateway.createSubscription({ billableId: 'x', plan: 'pro', period: 'monthly', price: 29 }),
    ).rejects.toBeInstanceOf(StripeRequestError)
  })
})

describe('StripeBillingGateway — webhook verification', () => {
  const gateway = makeGateway((async () => new Response()) as typeof fetch)

  it('verifies a valid signature and maps the event type + billableId', () => {
    const rawBody = JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { billableId: 'acme' } } },
    })
    const event = gateway.verifyWebhook(rawBody, stripeSignature(rawBody))
    expect(event).toEqual({ id: 'evt_1', type: 'subscription.canceled', billableId: 'acme' })
  })

  it('maps invoice events to payment success/failure', () => {
    const failed = JSON.stringify({
      id: 'evt_2',
      type: 'invoice.payment_failed',
      data: { object: { metadata: { billableId: 'acme' } } },
    })
    expect(gateway.verifyWebhook(failed, stripeSignature(failed))?.type).toBe('payment.failed')

    const paid = JSON.stringify({
      id: 'evt_3',
      type: 'invoice.paid',
      data: { object: { metadata: { billableId: 'acme' } } },
    })
    expect(gateway.verifyWebhook(paid, stripeSignature(paid))?.type).toBe('payment.succeeded')
  })

  it('rejects a bad signature, a missing header and a stale timestamp', () => {
    const rawBody = JSON.stringify({ id: 'evt_4', type: 'invoice.paid', data: { object: { metadata: { billableId: 'a' } } } })
    expect(() => gateway.verifyWebhook(rawBody, 't=1,v1=deadbeef')).toThrowError(WebhookInvalidError)
    expect(() => gateway.verifyWebhook(rawBody, undefined)).toThrowError(WebhookInvalidError)

    const stale = Math.floor(NOW_MS / 1000) - 10_000 // older than the 300s tolerance
    expect(() => gateway.verifyWebhook(rawBody, stripeSignature(rawBody, WEBHOOK_SECRET, stale))).toThrowError(
      WebhookInvalidError,
    )
  })

  it('returns null for verified but unmapped events', () => {
    const rawBody = JSON.stringify({ id: 'evt_5', type: 'customer.created', data: { object: {} } })
    expect(gateway.verifyWebhook(rawBody, stripeSignature(rawBody))).toBeNull()
  })

  it('returns null when the billable id cannot be resolved', () => {
    const rawBody = JSON.stringify({ id: 'evt_6', type: 'invoice.paid', data: { object: {} } })
    expect(gateway.verifyWebhook(rawBody, stripeSignature(rawBody))).toBeNull()
  })
})

describe('Stripe driver end to end with Subscriptions', () => {
  it('a verified cancellation webhook flips local state', async () => {
    const gateway = makeGateway((async () => new Response()) as typeof fetch)
    const subscriptions = new Subscriptions({
      plans: definePlans({ pro: { price: 29, features: {} } }),
    })
    await subscriptions.subscribe('acme', 'pro')

    const rawBody = JSON.stringify({
      id: 'evt_9',
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { billableId: 'acme' } } },
    })
    const event = gateway.verifyWebhook(rawBody, stripeSignature(rawBody))
    expect(event).not.toBeNull()
    await subscriptions.handleWebhook(event!)
    expect((await subscriptions.get('acme'))?.status).toBe('canceled')
  })
})
