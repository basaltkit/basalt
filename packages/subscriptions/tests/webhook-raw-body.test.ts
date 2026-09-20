import { createHmac, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { EXPRESS, expressPlugin } from '@basaltkit/express'
import { HONO, honoPlugin } from '@basaltkit/hono'
import { afterEach, describe, expect, it } from 'vitest'
import {
  billingWebhookRoute,
  definePlans,
  SUBSCRIPTIONS,
  subscriptionsPlugin,
  WebhookInvalidError,
  type BillingGateway,
  type WebhookEvent,
} from '../src/index.js'

/**
 * The bug: `billingWebhookRoute` used to fall back to
 * `JSON.stringify(request.body)` when the raw body was absent — which it
 * always was, on every adapter. Against a real Stripe/Paddle/Lemon endpoint
 * that produces a signature mismatch on every single delivery, because the
 * signature covers the bytes that arrived and `JSON.stringify` of the parsed
 * object is a different message.
 *
 * The gateway below signs the way the real ones do: an HMAC over the raw
 * payload. The payload is deliberately shaped so that parsing and
 * re-serialising it changes the bytes — spaces, key order, and `1.50`, which
 * re-prints as `1.5`. Nothing here is exotic; it is what a provider's JSON
 * actually looks like.
 */

const SECRET = 'whsec_test'

const PAYLOAD = '{\n  "id": "evt_9",\n  "type": "payment.failed",\n  "billableId": "acme",\n  "amount": 1.50\n}'

const sign = (raw: string): string => createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')

/** A gateway that verifies the way Stripe does: HMAC over the untouched body. */
class SigningGateway implements BillingGateway {
  readonly name = 'signing'
  /** Every payload it was asked to verify, in order — the evidence of what the route passed. */
  readonly seen: string[] = []

  async createSubscription(): Promise<{ gatewayRef: string }> {
    return { gatewayRef: 'sub_1' }
  }
  async cancelSubscription(): Promise<void> {}

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null {
    this.seen.push(rawBody)
    const expected = Buffer.from(sign(rawBody), 'utf8')
    const got = Buffer.from(signature ?? '', 'utf8')
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new WebhookInvalidError()
    return JSON.parse(rawBody) as WebhookEvent
  }
}

const plans = definePlans({ free: { price: 0, features: {} }, pro: { price: 29, features: {} } })

let app: BasaltApp | undefined
let server: Server | undefined

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
  await app?.shutdown()
  server = undefined
  app = undefined
})

type Post = (body: string, signature: string) => Promise<{ status: number; json: unknown }>

async function bootFastify(gateway: SigningGateway): Promise<Post> {
  app = await createApp({
    plugins: [
      subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
      fastifyPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
    ],
  }).boot()
  const instance = app.container.get(FASTIFY)
  await instance.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`
  server = instance.server
  return async (body, signature) => {
    const res = await fetch(`${base}/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
    })
    return { status: res.status, json: await res.json() }
  }
}

async function bootExpress(gateway: SigningGateway): Promise<Post> {
  app = await createApp({
    plugins: [
      subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
      expressPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
    ],
  }).boot()
  server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return async (body, signature) => {
    const res = await fetch(`${base}/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body,
    })
    return { status: res.status, json: await res.json() }
  }
}

async function bootHono(gateway: SigningGateway): Promise<Post> {
  app = await createApp({
    plugins: [
      subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
      honoPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
    ],
  }).boot()
  const hono = app.container.get(HONO)
  return async (body, signature) => {
    const res = await hono.fetch(
      new Request('http://local/billing/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body,
      }),
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    )
    return { status: res.status, json: await res.json() }
  }
}

const adapters: [string, (g: SigningGateway) => Promise<Post>][] = [
  ['fastify', bootFastify],
  ['express', bootExpress],
  ['hono', bootHono],
]

describe.each(adapters)('billingWebhookRoute on %s', (_name, boot) => {
  it('verifies the signature over the bytes that arrived', async () => {
    const gateway = new SigningGateway()
    const post = await boot(gateway)
    const res = await post(PAYLOAD, sign(PAYLOAD))
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ received: true, duplicate: false })
    // What the gateway was handed is byte-for-byte what the client sent — and
    // NOT what a re-serialisation would have produced.
    expect(gateway.seen).toEqual([PAYLOAD])
    expect(gateway.seen[0]).not.toBe(JSON.stringify(JSON.parse(PAYLOAD)))
  })

  it('still rejects a forged signature', async () => {
    const gateway = new SigningGateway()
    const post = await boot(gateway)
    const res = await post(PAYLOAD, sign('{"id":"evt_evil"}'))
    expect(res.status).toBe(400)
    expect((res.json as { error: { code: string } }).error.code).toBe('BILLING_WEBHOOK_INVALID')
  })

  it('applies the event and is idempotent on the gateway\'s retry', async () => {
    const gateway = new SigningGateway()
    const post = await boot(gateway)
    const subscriptions = app!.container.get(SUBSCRIPTIONS)
    await subscriptions.subscribe('acme', 'pro')
    expect((await post(PAYLOAD, sign(PAYLOAD))).json).toEqual({ received: true, duplicate: false })
    expect((await subscriptions.get('acme'))?.status).toBe('past_due')
    expect((await post(PAYLOAD, sign(PAYLOAD))).json).toEqual({ received: true, duplicate: true })
  })
})

describe('the shape of the payload this is about', () => {
  it('is one a parse-and-re-serialise round trip does not preserve', () => {
    // If this ever stops being true the tests above stop proving anything.
    expect(JSON.stringify(JSON.parse(PAYLOAD))).not.toBe(PAYLOAD)
    expect(sign(JSON.stringify(JSON.parse(PAYLOAD)))).not.toBe(sign(PAYLOAD))
  })
})
