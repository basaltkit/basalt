import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  LemonSqueezyBillingGateway,
  PaddleBillingGateway,
  StripeBillingGateway,
  WebhookSecretMissingError,
  type BillingGateway,
} from '../src/index.js'

/**
 * Webhook verification must fail closed when no signing secret is configured.
 * The classic misconfiguration is `webhookSecret: process.env.X ?? ''` — with an
 * empty key, HMAC is still computable by anyone, so a forged `payment.succeeded`
 * would verify. Every built-in driver must refuse instead (like AppyPay/ProxyPay).
 */

const NOW_MS = 1_700_000_000_000
const ts = Math.floor(NOW_MS / 1000)
const noFetch: typeof fetch = async () => {
  throw new Error('no network in this test')
}

const stripeBody = JSON.stringify({
  id: 'evt_forged',
  type: 'invoice.paid',
  data: { object: { subscription: 'sub_x', metadata: { billableId: 'victim' } } },
})
const paddleBody = JSON.stringify({
  event_id: 'evt_forged',
  event_type: 'transaction.completed',
  data: { id: 'txn_x', subscription_id: 'sub_x', custom_data: { billableId: 'victim' } },
})
const lemonBody = JSON.stringify({
  meta: { event_name: 'subscription_payment_success', custom_data: { billableId: 'victim' } },
  data: { id: '1', attributes: { subscription_id: 7 } },
})

const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex')

type Case = [string, (secret: string) => BillingGateway, string, (secret: string) => string]

const cases: Case[] = [
  [
    'stripe',
    (webhookSecret) =>
      new StripeBillingGateway({
        secretKey: 'sk_test',
        webhookSecret,
        priceId: () => 'price_x',
        customerId: (id) => `cus_${id}`,
        fetch: noFetch,
        now: () => NOW_MS,
      }),
    stripeBody,
    (secret) => `t=${ts},v1=${hmac(secret, `${ts}.${stripeBody}`)}`,
  ],
  [
    'paddle',
    (webhookSecret) =>
      new PaddleBillingGateway({
        apiKey: 'pdl_test',
        webhookSecret,
        priceId: () => 'pri_x',
        customerId: (id) => `ctm_${id}`,
        fetch: noFetch,
        now: () => NOW_MS,
      }),
    paddleBody,
    (secret) => `ts=${ts};h1=${hmac(secret, `${ts}:${paddleBody}`)}`,
  ],
  [
    'lemonsqueezy',
    (webhookSecret) =>
      new LemonSqueezyBillingGateway({
        apiKey: 'ls_key',
        webhookSecret,
        storeId: '1',
        variantId: () => 'var_x',
        fetch: noFetch,
      }),
    lemonBody,
    (secret) => hmac(secret, lemonBody),
  ],
]

describe.each(cases)('%s driver — webhook verification fails closed without a secret', (_name, make, body, sign) => {
  it('refuses an event signed with the empty key when webhookSecret is ""', () => {
    const gateway = make('')
    expect(() => gateway.verifyWebhook(body, sign(''))).toThrow(WebhookSecretMissingError)
  })

  it('refuses when webhookSecret is whitespace only', () => {
    const gateway = make('   ')
    expect(() => gateway.verifyWebhook(body, sign('   '))).toThrow(WebhookSecretMissingError)
  })

  it('refuses when webhookSecret is undefined at runtime (untyped config)', () => {
    const gateway = make(undefined as unknown as string)
    expect(() => gateway.verifyWebhook(body, sign(''))).toThrow(WebhookSecretMissingError)
  })

  it('still verifies a correctly signed event when a secret is configured', () => {
    const gateway = make('whsec_real_secret')
    expect(gateway.verifyWebhook(body, sign('whsec_real_secret'))).toMatchObject({ billableId: 'victim' })
  })
})
