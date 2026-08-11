import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebhookInvalidError } from '@basaltkit/subscriptions'
import { AppyPayGateway, AppyPayRequestError, APPYPAY_WIRE, type FetchLike } from '../src/index.js'

const TOKEN_URL = 'https://auth.test/token'
const tokenBody = JSON.stringify({ access_token: 'tok-123', expires_in: 3600 })

// Fake fetch: routes by exact URL (token) or "METHOD path" (API), records calls.
function fakeFetch(routes: Record<string, { status: number; body?: string }>) {
  const calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, ...(init?.headers ? { headers: init.headers } : {}), ...(init?.body ? { body: init.body } : {}) })
    const path = url.replace(/^https?:\/\/[^/]+/, '')
    const route = routes[url] ?? routes[`${method} ${path}`] ?? routes[`${method} *`]
    if (!route) return { ok: false, status: 404, text: async () => 'no route' }
    return { ok: route.status >= 200 && route.status < 300, status: route.status, text: async () => route.body ?? '' }
  }
  return { fetch, calls }
}

const creds = { clientId: 'id', clientSecret: 'sec', tokenUrl: TOKEN_URL }
const opts = (fetch: FetchLike) => ({ ...creds, sandbox: true, fetch })
const fakeOk = (async () => ({ ok: true, status: 200, text: async () => '' })) as FetchLike

describe('AppyPayGateway.createPayment', () => {
  it('gets a token, posts a reference charge, and maps the instruction', async () => {
    const { fetch, calls } = fakeFetch({
      [TOKEN_URL]: { status: 200, body: tokenBody },
      'POST /v1.0/charges': { status: 200, body: JSON.stringify({ id: 'chg_1', entity: '00123', reference: '987654321' }) },
    })
    const gw = new AppyPayGateway(opts(fetch))

    const inst = await gw.createPayment({ billableId: 'acme', amount: 5000, reference: 'order_1' })

    expect(inst.id).toBe('chg_1')
    expect(inst.status).toBe('pending')
    expect(inst.reference).toEqual({ entity: '00123', reference: '987654321', amount: 5000 })

    const charge = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1.0/charges'))!
    expect(charge.headers?.Authorization).toBe('Bearer tok-123')
    const body = JSON.parse(charge.body!)
    expect(body.merchantTransactionId).toBe('order_1')
    expect(body.amount).toBe(5000)
    expect(body.currency).toBe('AOA')
    expect(body.paymentMethod).toBe(APPYPAY_WIRE.method.reference)
    expect(body.metadata.billable_id).toBe('acme')
  })

  it('caches the OAuth token across calls', async () => {
    const { fetch, calls } = fakeFetch({
      [TOKEN_URL]: { status: 200, body: tokenBody },
      'POST /v1.0/charges': { status: 200, body: JSON.stringify({ id: 'x', entity: 'e', reference: 'r' }) },
    })
    const gw = new AppyPayGateway(opts(fetch))
    await gw.createPayment({ billableId: 'a', amount: 1, reference: 'r1' })
    await gw.createPayment({ billableId: 'a', amount: 2, reference: 'r2' })
    expect(calls.filter((c) => c.url === TOKEN_URL).length).toBe(1)
  })

  it('sends a Multicaixa Express push and returns push.phone', async () => {
    const { fetch, calls } = fakeFetch({
      [TOKEN_URL]: { status: 200, body: tokenBody },
      'POST /v1.0/charges': { status: 200, body: JSON.stringify({ id: 'chg_2' }) },
    })
    const gw = new AppyPayGateway(opts(fetch))

    const inst = await gw.createPayment({
      billableId: 'acme',
      amount: 100,
      reference: 'order_x',
      customer: { phone: '+244900000000' },
      metadata: { appypay_method: 'express' },
    })

    expect(inst.push).toEqual({ phone: '+244900000000' })
    const body = JSON.parse(calls.find((c) => c.url.endsWith('/v1.0/charges'))!.body!)
    expect(body.paymentMethod).toBe(APPYPAY_WIRE.method.express)
    expect(body.paymentInfo).toEqual({ phoneNumber: '+244900000000' })
  })

  it('rejects express without a phone', async () => {
    const { fetch } = fakeFetch({ [TOKEN_URL]: { status: 200, body: tokenBody } })
    const gw = new AppyPayGateway(opts(fetch))
    await expect(
      gw.createPayment({ billableId: 'a', amount: 1, metadata: { appypay_method: 'express' } }),
    ).rejects.toBeInstanceOf(AppyPayRequestError)
  })

  it('surfaces a token error with its HTTP status', async () => {
    const { fetch } = fakeFetch({ [TOKEN_URL]: { status: 401, body: 'unauthorized' } })
    const gw = new AppyPayGateway(opts(fetch))
    await expect(gw.createPayment({ billableId: 'a', amount: 1, reference: 'r' })).rejects.toBeInstanceOf(AppyPayRequestError)
  })
})

describe('AppyPayGateway.verifyWebhook', () => {
  const secret = 'whsec'
  const gw = new AppyPayGateway({ ...creds, webhookSecret: secret, fetch: fakeOk })
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex')

  it('verifies the HMAC and maps a successful payment', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      merchantTransactionId: 'order_1',
      status: 'SUCCESS',
      amount: '5000.00',
      metadata: { billable_id: 'acme', reference: 'order_1' },
    })
    const event = gw.verifyWebhook(body, sign(body))
    expect(event).toMatchObject({
      id: 'evt_1',
      type: 'payment.succeeded',
      paymentId: 'order_1',
      amount: 5000,
      billableId: 'acme',
      reference: 'order_1',
    })
  })

  it('maps a failed payment', () => {
    const body = JSON.stringify({ merchantTransactionId: 'order_2', status: 'FAILED', amount: 10 })
    expect(gw.verifyWebhook(body, sign(body))?.type).toBe('payment.failed')
  })

  it('returns null for a non-terminal status', () => {
    const body = JSON.stringify({ status: 'PENDING', merchantTransactionId: 'order_3' })
    expect(gw.verifyWebhook(body, sign(body))).toBeNull()
  })

  it('throws on a bad signature', () => {
    const body = JSON.stringify({ status: 'SUCCESS', merchantTransactionId: 'x', amount: 1 })
    expect(() => gw.verifyWebhook(body, 'deadbeef')).toThrow(WebhookInvalidError)
  })
})
