import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  definePlans,
  LemonSqueezyBillingGateway,
  PaddleBillingGateway,
  StripeBillingGateway,
  Subscriptions,
} from '../src/index.js'

/**
 * Red-team follow-up to F13. The attested plan is read from metadata stamped at
 * checkout time, but the PRICE of a gateway subscription can change afterwards
 * (a local swap(), or a plan change in the gateway's customer portal) while the
 * metadata keeps naming the old plan. A later renewal of that subscription then
 * "attests" a plan that is no longer being paid for. Once that subscription's
 * ref is no longer the one on file, the stale attestation promotes a pending
 * enterprise intent: pay basic, get enterprise.
 *
 * Drivers must only attest a plan that is bound to the price actually charged.
 */

const plans = definePlans({
  basic: { price: 10, features: { seats: 5 } },
  enterprise: { price: 500, features: { seats: 500 } },
})
const urls = { successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' }
const NOW_MS = 1_700_000_000_000
const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex')

/** A tiny Stripe double: tracks each subscription's price and metadata. */
function fakeStripe() {
  const subs = new Map<string, { price: string; metadata: Record<string, string> }>()
  const sessions = new Map<string, Record<string, string>>()
  let n = 0
  const gateway = new StripeBillingGateway({
    secretKey: 'sk_test',
    webhookSecret: 'whsec_test',
    priceId: (plan, period) => `price_${plan}_${period}`,
    customerId: (id) => `cus_${id}`,
    now: () => NOW_MS,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname
      const method = init?.method ?? 'GET'
      const form = new URLSearchParams(String(init?.body ?? ''))
      if (path === '/v1/checkout/sessions') {
        const id = `cs_${++n}`
        const metadata: Record<string, string> = {}
        for (const [k, v] of form) {
          const m = /^subscription_data\[metadata\]\[(.+)\]$/.exec(k)
          if (m) metadata[m[1]!] = v
        }
        sessions.set(id, { price: form.get('line_items[0][price]')!, ...metadata })
        return new Response(JSON.stringify({ id, url: `https://stripe.test/${id}` }))
      }
      const sub = /^\/v1\/subscriptions\/(.+)$/.exec(path)
      if (sub && method === 'GET') {
        return new Response(JSON.stringify({ id: sub[1], items: { data: [{ id: `si_${sub[1]}` }] } }))
      }
      if (sub && method === 'POST') {
        const record = subs.get(sub[1]!)!
        const price = form.get('items[0][price]')
        if (price) record.price = price
        for (const [k, v] of form) {
          const m = /^metadata\[(.+)\]$/.exec(k)
          if (m) record.metadata[m[1]!] = v
        }
        return new Response(JSON.stringify({ id: sub[1] }))
      }
      return new Response('{}')
    },
  })
  /** The customer pays checkout session `cs` → Stripe creates subscription `ref`. */
  const complete = (cs: string, ref: string) => {
    const { price, ...metadata } = sessions.get(cs)!
    subs.set(ref, { price: price!, metadata })
  }
  /** Stripe's signed invoice.paid for a (renewal of a) subscription. */
  const invoicePaid = (evt: string, ref: string) => {
    const s = subs.get(ref)!
    const body = JSON.stringify({
      id: evt,
      type: 'invoice.paid',
      data: {
        object: {
          object: 'invoice',
          subscription: ref,
          billing_reason: 'subscription_cycle',
          subscription_details: { metadata: s.metadata },
          lines: { data: [{ price: { id: s.price }, proration: false }] },
        },
      },
    })
    const t = Math.floor(NOW_MS / 1000)
    return gateway.verifyWebhook(body, `t=${t},v1=${hmac('whsec_test', `${t}.${body}`)}`)!
  }
  /** A plan change made OUTSIDE Basalt (e.g. the Stripe customer portal): price only. */
  const portalChangePrice = (ref: string, price: string) => {
    subs.get(ref)!.price = price
  }
  return { gateway, subs, complete, invoicePaid, portalChangePrice }
}

describe('attested plan must be bound to the price actually charged (stripe)', () => {
  it('swap() keeps the subscription metadata in step with the new price', async () => {
    const stripe = fakeStripe()
    const subs = new Subscriptions({ plans, gateway: stripe.gateway })
    await subs.checkout('acme', 'enterprise', urls)
    stripe.complete('cs_1', 'sub_A')
    await subs.handleWebhook(stripe.invoicePaid('evt_1', 'sub_A'))
    expect((await subs.get('acme'))!.plan).toBe('enterprise')

    await subs.swap('acme', 'basic')
    expect(stripe.subs.get('sub_A')).toMatchObject({
      price: 'price_basic_monthly',
      metadata: { plan: 'basic', period: 'monthly', billableId: 'acme' },
    })
  })

  it('a renewal whose metadata names a plan the charged price does not match attests nothing', () => {
    const stripe = fakeStripe()
    stripe.subs.set('sub_A', {
      price: 'price_basic_monthly',
      metadata: { billableId: 'acme', plan: 'enterprise', period: 'monthly' },
    })
    const event = stripe.invoicePaid('evt_1', 'sub_A')
    expect(event).toMatchObject({ billableId: 'acme', gatewayRef: 'sub_A' })
    expect(event).not.toHaveProperty('plan')
    expect(event).not.toHaveProperty('period')
  })

  it('an invoice with no identifiable non-proration price attests nothing (fail closed)', () => {
    const stripe = fakeStripe()
    const body = JSON.stringify({
      id: 'evt_x',
      type: 'invoice.paid',
      data: {
        object: {
          subscription: 'sub_A',
          subscription_details: { metadata: { billableId: 'acme', plan: 'enterprise', period: 'monthly' } },
          lines: { data: [{ price: { id: 'price_enterprise_monthly' }, proration: true }] },
        },
      },
    })
    const t = Math.floor(NOW_MS / 1000)
    const event = stripe.gateway.verifyWebhook(body, `t=${t},v1=${hmac('whsec_test', `${t}.${body}`)}`)!
    expect(event).not.toHaveProperty('plan')
  })

  it('newer API shape (pricing.price_details.price) is recognised', () => {
    const stripe = fakeStripe()
    const body = JSON.stringify({
      id: 'evt_y',
      type: 'invoice.paid',
      data: {
        object: {
          parent: {
            subscription_details: {
              subscription: 'sub_A',
              metadata: { billableId: 'acme', plan: 'basic', period: 'yearly' },
            },
          },
          lines: { data: [{ pricing: { price_details: { price: 'price_basic_yearly' } } }] },
        },
      },
    })
    const t = Math.floor(NOW_MS / 1000)
    const event = stripe.gateway.verifyWebhook(body, `t=${t},v1=${hmac('whsec_test', `${t}.${body}`)}`)!
    expect(event).toMatchObject({ plan: 'basic', period: 'yearly' })
  })

  it('end to end: pay basic (after a portal downgrade), get enterprise — refused', async () => {
    const stripe = fakeStripe()
    const subs = new Subscriptions({ plans, gateway: stripe.gateway })

    // 1. Legit enterprise subscription A.
    await subs.checkout('acme', 'enterprise', urls)
    stripe.complete('cs_1', 'sub_A')
    await subs.handleWebhook(stripe.invoicePaid('evt_1', 'sub_A'))

    // 2. The customer downgrades A to basic in the gateway portal. Stripe
    //    changes the price; the metadata still says "enterprise". (The app's
    //    portal webhook handling syncs the local plan to basic.)
    stripe.portalChangePrice('sub_A', 'price_basic_monthly')
    await subs.swap('acme', 'basic', { prorate: false })
    stripe.portalChangePrice('sub_A', 'price_basic_monthly')
    stripe.subs.get('sub_A')!.metadata['plan'] = 'enterprise' // what the portal leaves behind

    // 3. A second cheap subscription B, so A's ref is no longer the one on file.
    await subs.checkout('acme', 'basic', urls)
    stripe.complete('cs_2', 'sub_B')
    await subs.handleWebhook(stripe.invoicePaid('evt_2', 'sub_B'))
    expect((await subs.get('acme'))!).toMatchObject({ plan: 'basic', gatewayRef: 'sub_B' })

    // 4. Start an enterprise checkout and abandon it (pendingPlan = enterprise).
    await subs.checkout('acme', 'enterprise', urls)

    // 5. A (charging BASIC) renews. Its stale metadata must not attest enterprise.
    await subs.handleWebhook(stripe.invoicePaid('evt_3', 'sub_A'))
    expect((await subs.get('acme'))!.plan).toBe('basic')
    expect(await subs.subscribed('acme', 'enterprise')).toBe(false)
  })

  it('a legitimate upgrade checkout (price matches the attested plan) still promotes', async () => {
    const stripe = fakeStripe()
    const subs = new Subscriptions({ plans, gateway: stripe.gateway })
    await subs.checkout('acme', 'basic', urls)
    stripe.complete('cs_1', 'sub_A')
    await subs.handleWebhook(stripe.invoicePaid('evt_1', 'sub_A'))
    await subs.checkout('acme', 'enterprise', urls)
    stripe.complete('cs_2', 'sub_B')
    await subs.handleWebhook(stripe.invoicePaid('evt_2', 'sub_B'))
    expect((await subs.get('acme'))!).toMatchObject({ plan: 'enterprise', gatewayRef: 'sub_B', status: 'active' })
  })
})

describe('attested plan must be bound to the price actually charged (paddle)', () => {
  const gateway = new PaddleBillingGateway({
    apiKey: 'k',
    webhookSecret: 'ntfset_test',
    priceId: (plan, period) => `pri_${plan}_${period}`,
    customerId: (id) => id,
    now: () => NOW_MS,
  })
  const verify = (items: unknown[]) => {
    const body = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        subscription_id: 'sub_A',
        custom_data: { billableId: 'acme', plan: 'enterprise', period: 'monthly' },
        items,
      },
    })
    const ts = Math.floor(NOW_MS / 1000)
    return gateway.verifyWebhook(body, `ts=${ts};h1=${hmac('ntfset_test', `${ts}:${body}`)}`)!
  }

  it('a transaction charging the basic price does not attest enterprise from stale custom_data', () => {
    expect(verify([{ price: { id: 'pri_basic_monthly' }, quantity: 1 }])).not.toHaveProperty('plan')
  })

  it('a transaction without items attests nothing (fail closed)', () => {
    expect(verify([])).not.toHaveProperty('plan')
  })

  it('a transaction charging the attested price attests it', () => {
    expect(verify([{ price: { id: 'pri_enterprise_monthly' }, quantity: 1 }])).toMatchObject({
      plan: 'enterprise',
      period: 'monthly',
    })
    expect(verify([{ price_id: 'pri_enterprise_monthly', quantity: 1 }])).toMatchObject({ plan: 'enterprise' })
  })
})

describe('attested plan must be bound to the price actually charged (lemonsqueezy)', () => {
  const gateway = new LemonSqueezyBillingGateway({
    apiKey: 'k',
    webhookSecret: 'ls_secret',
    storeId: '1',
    variantId: (plan, period) => `v_${plan}_${period}`,
  })
  const verify = (attributes: Record<string, unknown>) => {
    const body = JSON.stringify({
      meta: {
        event_name: 'subscription_payment_success',
        custom_data: { billableId: 'acme', plan: 'enterprise', period: 'monthly' },
      },
      data: { id: '9', attributes: { subscription_id: 7, ...attributes } },
    })
    return gateway.verifyWebhook(body, hmac('ls_secret', body))!
  }

  it('a renewal invoice does not attest the (immutable, possibly stale) checkout custom data', () => {
    // Lemon custom data is fixed at checkout; a later variant change (swap or
    // portal) does not update it, so only the INITIAL invoice is bound to it.
    expect(verify({ billing_reason: 'renewal' })).not.toHaveProperty('plan')
    expect(verify({ billing_reason: 'updated' })).not.toHaveProperty('plan')
    expect(verify({})).not.toHaveProperty('plan')
  })

  it('the initial invoice of the checkout attests the plan', () => {
    expect(verify({ billing_reason: 'initial' })).toMatchObject({ plan: 'enterprise', period: 'monthly' })
  })
})

describe('stripe: newer API invoices (subscription id under parent.subscription_details)', () => {
  const gateway = new StripeBillingGateway({
    secretKey: 'sk_test',
    webhookSecret: 'whsec_test',
    priceId: (plan, period) => `price_${plan}_${period}`,
    customerId: (id) => `cus_${id}`,
    now: () => NOW_MS,
    fetch: async () => new Response(JSON.stringify({ id: 'cs_1', url: 'https://stripe.test/cs_1' })),
  })
  const sign = (payload: unknown) => {
    const body = JSON.stringify(payload)
    const t = Math.floor(NOW_MS / 1000)
    return gateway.verifyWebhook(body, `t=${t},v1=${hmac('whsec_test', `${t}.${body}`)}`)!
  }
  const basilInvoicePaid = (evt: string, invoiceId: string) =>
    sign({
      id: evt,
      type: 'invoice.paid',
      data: {
        object: {
          object: 'invoice',
          id: invoiceId,
          parent: {
            type: 'subscription_details',
            subscription_details: {
              subscription: 'sub_A',
              metadata: { billableId: 'acme', plan: 'basic', period: 'monthly' },
            },
          },
          lines: { data: [{ pricing: { price_details: { price: 'price_basic_monthly' } } }] },
        },
      },
    })

  it('the gateway ref is the SUBSCRIPTION id, never the invoice id', () => {
    expect(basilInvoicePaid('evt_1', 'in_1')).toMatchObject({ gatewayRef: 'sub_A', plan: 'basic' })
  })

  it('a final invoice paid after the deletion does not revive the canceled subscription', async () => {
    const subs = new Subscriptions({ plans, gateway })
    await subs.checkout('acme', 'basic', urls)
    await subs.handleWebhook(basilInvoicePaid('evt_1', 'in_1'))
    expect((await subs.get('acme'))!).toMatchObject({ status: 'active', gatewayRef: 'sub_A' })

    await subs.handleWebhook(
      sign({
        id: 'evt_2',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            object: 'subscription',
            id: 'sub_A',
            metadata: { billableId: 'acme', plan: 'basic', period: 'monthly' },
            items: { data: [{ price: { id: 'price_basic_monthly' } }] },
          },
        },
      }),
    )
    // The final invoice of the SAME subscription arrives after the deletion.
    await subs.handleWebhook(basilInvoicePaid('evt_3', 'in_2'))
    expect((await subs.get('acme'))!).toMatchObject({ status: 'canceled', gatewayRef: 'sub_A' })
    expect(await subs.subscribed('acme')).toBe(false)
  })
})
