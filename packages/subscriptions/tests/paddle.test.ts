import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PaddleBillingGateway, PaddleRequestError, WebhookInvalidError } from '../src/index.js'

const WEBHOOK_SECRET = 'ntfset_test'
const NOW_MS = 1_700_000_000_000

/** Signs a raw body the way Paddle does: HMAC-SHA256 over `${ts}:${body}`. */
function paddleSignature(rawBody: string, secret = WEBHOOK_SECRET, ts = Math.floor(NOW_MS / 1000)): string {
  const h1 = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex')
  return `ts=${ts};h1=${h1}`
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
  new Response(JSON.stringify({ data: d }), { status, headers: { 'content-type': 'application/json' } })

function makeGateway(fetchMock: typeof fetch) {
  return new PaddleBillingGateway({
    apiKey: 'pdl_test',
    webhookSecret: WEBHOOK_SECRET,
    priceId: (plan, period) => `pri_${plan}_${period}`,
    customerId: (billableId) => `ctm_${billableId}`,
    fetch: fetchMock,
    now: () => NOW_MS,
  })
}

describe('PaddleBillingGateway — API calls', () => {
  it('createSubscription creates a transaction with the price, customer and custom_data', async () => {
    const { calls, fetchMock } = harness(() => data({ id: 'txn_1' }))
    const res = await makeGateway(fetchMock).createSubscription({
      billableId: 'acme',
      plan: 'pro',
      period: 'monthly',
      price: 2900,
    })
    expect(res).toEqual({ gatewayRef: 'txn_1' })
    expect(calls[0]!.url).toBe('https://api.paddle.com/transactions')
    expect(calls[0]!.headers.authorization).toBe('Bearer pdl_test')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.items).toEqual([{ price_id: 'pri_pro_monthly', quantity: 1 }])
    expect(body.customer_id).toBe('ctm_acme')
    expect(body.custom_data).toEqual({ billableId: 'acme' })
  })

  it('cancelSubscription maps atPeriodEnd → effective_from', async () => {
    const end = harness(() => data({}))
    await makeGateway(end.fetchMock).cancelSubscription('sub_1', { atPeriodEnd: true })
    expect(end.calls[0]!.url).toBe('https://api.paddle.com/subscriptions/sub_1/cancel')
    expect(JSON.parse(end.calls[0]!.body!).effective_from).toBe('next_billing_period')

    const now = harness(() => data({}))
    await makeGateway(now.fetchMock).cancelSubscription('sub_1', { atPeriodEnd: false })
    expect(JSON.parse(now.calls[0]!.body!).effective_from).toBe('immediately')
  })

  it('createCheckoutSession returns the transaction checkout url', async () => {
    const { fetchMock } = harness(() => data({ id: 'txn_2', checkout: { url: 'https://pay.paddle.com/x' } }))
    const res = await makeGateway(fetchMock).createCheckoutSession({
      billableId: 'acme',
      plan: 'pro',
      period: 'yearly',
      successUrl: 'https://app/ok',
      cancelUrl: 'https://app/no',
    })
    expect(res).toEqual({ url: 'https://pay.paddle.com/x', id: 'txn_2' })
  })

  it('createPortalSession returns the customer portal overview url', async () => {
    const { calls, fetchMock } = harness(() =>
      data({ urls: { general: { overview: 'https://portal/acme' } } }),
    )
    const res = await makeGateway(fetchMock).createPortalSession({ billableId: 'acme', returnUrl: 'https://app' })
    expect(res).toEqual({ url: 'https://portal/acme' })
    expect(calls[0]!.url).toBe('https://api.paddle.com/customers/ctm_acme/portal-sessions')
  })

  it('swapSubscription PATCHes the subscription with the mapped proration mode', async () => {
    const { calls, fetchMock } = harness(() => data({}))
    await makeGateway(fetchMock).swapSubscription('sub_1', { plan: 'team', period: 'monthly', prorationBehavior: 'none' })
    expect(calls[0]!.method).toBe('PATCH')
    expect(calls[0]!.url).toBe('https://api.paddle.com/subscriptions/sub_1')
    const body = JSON.parse(calls[0]!.body!)
    expect(body.items).toEqual([{ price_id: 'pri_team_monthly', quantity: 1 }])
    expect(body.proration_billing_mode).toBe('do_not_bill')
  })

  it('throws PaddleRequestError on a non-2xx', async () => {
    const { fetchMock } = harness(
      () => new Response(JSON.stringify({ error: { detail: 'bad price' } }), { status: 400 }),
    )
    await expect(
      makeGateway(fetchMock).createSubscription({ billableId: 'a', plan: 'p', period: 'monthly', price: 1 }),
    ).rejects.toBeInstanceOf(PaddleRequestError)
  })
})

describe('PaddleBillingGateway — verifyWebhook', () => {
  const gw = makeGateway((async () => new Response('{}')) as typeof fetch)

  it('verifies a signed transaction.completed → payment.succeeded', () => {
    const raw = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      data: { id: 'txn_9', subscription_id: 'sub_9', custom_data: { billableId: 'acme' } },
    })
    expect(gw.verifyWebhook(raw, paddleSignature(raw))).toEqual({
      id: 'evt_1',
      type: 'payment.succeeded',
      billableId: 'acme',
      gatewayRef: 'sub_9',
    })
  })

  it('maps subscription.canceled and reads the ref from data.id', () => {
    const raw = JSON.stringify({
      event_id: 'evt_2',
      event_type: 'subscription.canceled',
      data: { id: 'sub_9', custom_data: { billableId: 'acme' } },
    })
    expect(gw.verifyWebhook(raw, paddleSignature(raw))).toMatchObject({
      type: 'subscription.canceled',
      gatewayRef: 'sub_9',
    })
  })

  it('returns null for a verified but unmapped event', () => {
    const raw = JSON.stringify({ event_id: 'e', event_type: 'address.created', data: { custom_data: { billableId: 'a' } } })
    expect(gw.verifyWebhook(raw, paddleSignature(raw))).toBeNull()
  })

  it('rejects a bad, missing, or stale signature', () => {
    const raw = JSON.stringify({ event_id: 'e', event_type: 'transaction.completed', data: { custom_data: { billableId: 'a' } } })
    expect(() => gw.verifyWebhook(raw, undefined)).toThrow(WebhookInvalidError)
    expect(() => gw.verifyWebhook(raw, paddleSignature(raw, 'wrong-secret'))).toThrow(WebhookInvalidError)
    const stale = paddleSignature(raw, WEBHOOK_SECRET, Math.floor(NOW_MS / 1000) - 10_000)
    expect(() => gw.verifyWebhook(raw, stale)).toThrow(WebhookInvalidError)
  })
})
