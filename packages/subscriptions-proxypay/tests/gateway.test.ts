import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebhookInvalidError } from '@basaltkit/subscriptions'
import { ProxyPayGateway, ProxyPayRequestError, type FetchLike } from '../src/index.js'

// Fake fetch: routes by method+path, records calls, returns canned responses.
function fakeFetch(routes: Record<string, { status: number; body?: string }>) {
  const calls: { method: string; path: string; body?: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    calls.push({ method, path, ...(init?.body ? { body: init.body } : {}) })
    const key = `${method} ${path}`
    const route = routes[key] ?? routes[`${method} *`]
    if (!route) return { ok: false, status: 404, text: async () => 'no route' }
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => route.body ?? '' }
  }
  return { fetch, calls }
}

const opts = (fetch: FetchLike) => ({ apiKey: 'k', entity: '00123', sandbox: true, fetch })

describe('ProxyPayGateway.createPayment', () => {
  it('reserves a reference id, activates it, and returns the reference to pay', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /reference_ids': { status: 200, body: '900000001' },
      'PUT /references/900000001': { status: 204 },
    })
    const gw = new ProxyPayGateway(opts(fetch))

    const inst = await gw.createPayment({
      billableId: 'acme',
      amount: 5000,
      reference: 'order_1',
      metadata: { plan: 'pro' },
      expiresAt: Date.parse('2026-08-20T00:00:00Z'),
    })

    expect(inst).toEqual({
      id: '900000001',
      status: 'pending',
      reference: { entity: '00123', reference: '900000001', amount: 5000 },
    })
    // the PUT carried a 2-decimal amount + custom_fields + end_datetime
    const put = calls.find((c) => c.method === 'PUT')!
    const body = JSON.parse(put.body!)
    expect(body.amount).toBe('5000.00')
    expect(body.custom_fields).toEqual({ billable_id: 'acme', reference: 'order_1', plan: 'pro' })
    expect(body.end_datetime).toBe('2026-08-20T00:00:00.000Z')
  })

  it('surfaces a ProxyPay error with its HTTP status', async () => {
    const { fetch } = fakeFetch({ 'POST /reference_ids': { status: 401, body: 'unauthorized' } })
    const gw = new ProxyPayGateway(opts(fetch))
    await expect(gw.createPayment({ billableId: 'x', amount: 1 })).rejects.toBeInstanceOf(ProxyPayRequestError)
  })
})

describe('ProxyPayGateway.verifyWebhook', () => {
  const secret = 'whsec'
  const payload = JSON.stringify({
    id: 42,
    event_type: 'payment',
    data: {
      reference_id: '900000001',
      amount: '5000.00',
      transaction_id: 'tx_1',
      custom_fields: { billable_id: 'acme', reference: 'order_1' },
    },
  })
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex')

  it('verifies the HMAC and translates a payment event', () => {
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', webhookSecret: secret, fetch: (async () => ({ ok: true, status: 200, text: async () => '' })) as FetchLike })
    const event = gw.verifyWebhook(payload, sign(payload))
    expect(event).toMatchObject({
      id: '42',
      type: 'payment.succeeded',
      paymentId: '900000001',
      amount: 5000,
      billableId: 'acme',
      reference: 'order_1',
    })
  })

  it('throws on a bad signature', () => {
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', webhookSecret: secret, fetch: (async () => ({ ok: true, status: 200, text: async () => '' })) as FetchLike })
    expect(() => gw.verifyWebhook(payload, 'deadbeef')).toThrow(WebhookInvalidError)
  })

  it('returns null for a non-payment event', () => {
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', fetch: (async () => ({ ok: true, status: 200, text: async () => '' })) as FetchLike })
    expect(gw.verifyWebhook(JSON.stringify({ event_type: 'other', data: {} }), undefined)).toBeNull()
  })
})

describe('ProxyPayGateway.getPayment', () => {
  it('reports paid when the reference is gone (404)', async () => {
    const { fetch } = fakeFetch({ 'GET /references/900000001': { status: 404 } })
    const gw = new ProxyPayGateway(opts(fetch))
    expect((await gw.getPayment('900000001')).status).toBe('paid')
  })

  it('reports pending while the reference is still active', async () => {
    const { fetch } = fakeFetch({ 'GET /references/900000001': { status: 200, body: '{"amount":"5000.00"}' } })
    const gw = new ProxyPayGateway(opts(fetch))
    const inst = await gw.getPayment('900000001')
    expect(inst.status).toBe('pending')
    expect(inst.reference?.amount).toBe(5000)
  })
})
