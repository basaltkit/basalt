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

// A fetch that always succeeds — for verifyWebhook tests that never call the API.
const fakeOk = (async () => ({ ok: true, status: 200, text: async () => '' })) as FetchLike

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
      metadata: { plan: 'pro' },
      expiresAt: Date.parse('2026-08-20T00:00:00Z'),
    })

    expect(inst).toEqual({
      id: '900000001',
      status: 'pending',
      reference: { entity: '00123', reference: '900000001', amount: 5000 },
    })
    // the PUT carried a numeric amount, custom_fields, and a date-only end_datetime
    const put = calls.find((c) => c.method === 'PUT')!
    const body = JSON.parse(put.body!)
    expect(body.amount).toBe(5000) // number, not "5000.00"
    expect(body.custom_fields).toEqual({ billable_id: 'acme', plan: 'pro' })
    expect(body.end_datetime).toBe('2026-08-20') // date-only, not full ISO
  })

  it('uses a caller-supplied reference and skips the reserve round-trip', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /references/123456789': { status: 204 } })
    const gw = new ProxyPayGateway(opts(fetch))

    const inst = await gw.createPayment({ billableId: 'acme', amount: 100, reference: '123456789' })

    expect(inst.id).toBe('123456789')
    expect(inst.reference).toEqual({ entity: '00123', reference: '123456789', amount: 100 })
    // no POST /reference_ids
    expect(calls.some((c) => c.path === '/reference_ids')).toBe(false)
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.path).toBe('/references/123456789')
    expect(JSON.parse(put.body!).custom_fields).toEqual({ billable_id: 'acme', reference: '123456789' })
  })

  it('reserves a numeric id when the supplied reference is non-numeric', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /reference_ids': { status: 200, body: '900000123' },
      'PUT /references/900000123': { status: 204 },
    })
    const gw = new ProxyPayGateway(opts(fetch))

    const inst = await gw.createPayment({ billableId: 'acme', amount: 10, reference: 'demo:pro:123' })

    expect(inst.id).toBe('900000123')
    expect(calls.some((c) => c.path === '/reference_ids')).toBe(true) // reserved, not used as id
    const put = calls.find((c) => c.method === 'PUT')!
    expect(put.path).toBe('/references/900000123')
    // the logical reference is preserved for reconciliation
    expect(JSON.parse(put.body!).custom_fields.reference).toBe('demo:pro:123')
  })

  it('tags the reference with callback_url when configured', async () => {
    const { fetch, calls } = fakeFetch({ 'PUT /references/55': { status: 204 } })
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', sandbox: true, callbackUrl: 'https://app.example/webhook', fetch })

    await gw.createPayment({ billableId: 'acme', amount: 1, reference: '55' })

    const put = calls.find((c) => c.method === 'PUT')!
    expect(JSON.parse(put.body!).custom_fields.callback_url).toBe('https://app.example/webhook')
  })

  it('always sends end_datetime (required by ProxyPay), defaulting when omitted', async () => {
    const { fetch, calls } = fakeFetch({
      'POST /reference_ids': { status: 200, body: '900000009' },
      'PUT /references/900000009': { status: 204 },
    })
    const gw = new ProxyPayGateway(opts(fetch))
    await gw.createPayment({ billableId: 'acme', amount: 1 }) // no expiresAt
    const body = JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)
    expect(body.end_datetime).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('surfaces a ProxyPay error with its HTTP status', async () => {
    const { fetch } = fakeFetch({ 'POST /reference_ids': { status: 401, body: 'unauthorized' } })
    const gw = new ProxyPayGateway(opts(fetch))
    await expect(gw.createPayment({ billableId: 'x', amount: 1 })).rejects.toBeInstanceOf(ProxyPayRequestError)
  })
})

describe('ProxyPayGateway.verifyWebhook', () => {
  const secret = 'whsec'
  // ProxyPay posts a FLAT payment object (same shape as GET /payments items).
  const payload = JSON.stringify({
    id: 42,
    reference_id: '900000001',
    amount: '5000.00',
    transaction_id: 'tx_1',
    custom_fields: { billable_id: 'acme', reference: 'order_1' },
  })
  const sign = (body: string, key: string) => createHmac('sha256', key).update(body).digest('hex')

  it('verifies the HMAC and translates a flat payment payload', () => {
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', webhookSecret: secret, fetch: fakeOk })
    const event = gw.verifyWebhook(payload, sign(payload, secret))
    expect(event).toMatchObject({
      id: '42',
      type: 'payment.succeeded',
      paymentId: '900000001',
      amount: 5000,
      billableId: 'acme',
      reference: 'order_1',
    })
  })

  it('defaults the signing secret to the API key', () => {
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', fetch: fakeOk })
    const body = JSON.stringify({ reference_id: '7', amount: 10, custom_fields: { billable_id: 'acme' } })
    expect(gw.verifyWebhook(body, sign(body, 'k'))?.paymentId).toBe('7')
    expect(() => gw.verifyWebhook(body, 'deadbeef')).toThrow(WebhookInvalidError)
  })

  it('throws on a bad signature', () => {
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', webhookSecret: secret, fetch: fakeOk })
    expect(() => gw.verifyWebhook(payload, 'deadbeef')).toThrow(WebhookInvalidError)
  })

  it('returns null when the payload has no reference_id', () => {
    // webhookSecret: '' disables verification so we can feed an arbitrary body
    const gw = new ProxyPayGateway({ apiKey: 'k', entity: '00123', webhookSecret: '', fetch: fakeOk })
    expect(gw.verifyWebhook(JSON.stringify({ hello: 'world' }), undefined)).toBeNull()
  })
})
