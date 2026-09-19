import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  definePlans,
  FakeBillingGateway,
  LemonSqueezyBillingGateway,
  PaddleBillingGateway,
  StripeBillingGateway,
  Subscriptions,
} from '../src/index.js'

const plans = definePlans({
  basic: { price: 10, features: { seats: 5 } },
  enterprise: { price: 500, features: { seats: 500 } },
})

const checkoutUrls = { successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' }

/**
 * S-2 (ecosystem review 2026-08-b): checkout() must not let an ABANDONED
 * checkout rewrite the live subscription so that the next legitimately-signed
 * renewal webhook activates the escalated plan.
 */
describe('plan escalation via abandoned checkout (fail-closed)', () => {
  const activeBasic = async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.checkout('acme', 'basic', checkoutUrls)
    await subs.handleWebhook({ id: 'evt_initial', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_basic_1' })
    expect((await subs.get('acme'))!).toMatchObject({ plan: 'basic', status: 'active', gatewayRef: 'sub_basic_1' })
    return subs
  }

  it('an abandoned checkout + a renewal webhook does NOT escalate the plan', async () => {
    const subs = await activeBasic()

    // Attacker: start checkout for enterprise, never pay.
    await subs.checkout('acme', 'enterprise', checkoutUrls)

    // The live subscription must be untouched by the mere *intent*.
    const afterCheckout = (await subs.get('acme'))!
    expect(afterCheckout.plan).toBe('basic')
    expect(afterCheckout.status).toBe('active')
    expect(afterCheckout.gatewayRef).toBe('sub_basic_1')

    // The next genuine renewal of the BASIC subscription (same gateway ref).
    await subs.handleWebhook({ id: 'evt_renewal', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_basic_1' })

    const after = (await subs.get('acme'))!
    expect(after.plan).toBe('basic') // NOT enterprise
    expect(after.status).toBe('active')
    expect(await subs.subscribed('acme', 'enterprise')).toBe(false)
  })

  it('a COMPLETED upgrade checkout activates the new plan via its NEW gateway ref', async () => {
    const subs = await activeBasic()
    await subs.checkout('acme', 'enterprise', checkoutUrls)

    // Gateway confirms the NEW checkout — a different subscription ref, and the
    // plan it charged for (signed metadata surfaced by the driver).
    await subs.handleWebhook({ id: 'evt_upgrade', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_ent_2', plan: 'enterprise' })

    const after = (await subs.get('acme'))!
    expect(after.plan).toBe('enterprise')
    expect(after.status).toBe('active')
    expect(after.gatewayRef).toBe('sub_ent_2')
    expect(await subs.subscribed('acme', 'enterprise')).toBe(true)
    // the pending intent is consumed
    expect(after.pendingPlan).toBeUndefined()
  })

  it('a ref-less success event activates the CURRENT plan only, never the pending one', async () => {
    const subs = await activeBasic()
    await subs.checkout('acme', 'enterprise', checkoutUrls)
    await subs.handleWebhook({ id: 'evt_noref', type: 'payment.succeeded', billableId: 'acme' })
    const after = (await subs.get('acme'))!
    expect(after.plan).toBe('basic')
    expect(after.pendingPlan).toBe('enterprise') // intent survives, unconsumed
  })

  it('checkout no longer destroys the gateway ref (cancel keeps working)', async () => {
    const subs = await activeBasic()
    await subs.checkout('acme', 'enterprise', checkoutUrls)
    expect((await subs.get('acme'))!.gatewayRef).toBe('sub_basic_1')
  })

  it('webhook replay is idempotent (same event id applies once)', async () => {
    const subs = await activeBasic()
    const applied = await subs.handleWebhook({ id: 'evt_initial', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_basic_1' })
    expect(applied).toBe(false) // deduped by event id
  })
})

/**
 * B09/F13: interleaved checkouts. A single pending-intent field was promoted by
 * ANY new-ref payment, without tying the payment to the checkout that produced
 * it — pay the cheap session, receive the expensive plan. The plan change must
 * follow what the gateway attests was PAID, never the latest intent.
 */
describe('plan escalation via interleaved checkouts (pay cheap, get expensive)', () => {
  const plansWithFree = definePlans({
    free: { price: 0, features: { seats: 1 } },
    basic: { price: 10, features: { seats: 5 } },
    enterprise: { price: 500, features: { seats: 500 } },
  })

  it('existing subscriber: paying the basic session while an enterprise checkout is pending grants basic, not enterprise', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans: plansWithFree, gateway })
    await subs.subscribe('acme', 'free')

    await subs.checkout('acme', 'basic', checkoutUrls) // session A — kept
    await subs.checkout('acme', 'enterprise', checkoutUrls) // session B — abandoned
    // The gateway confirms session A: new subscription, paid plan = basic.
    await subs.handleWebhook({
      id: 'evt_pay_A', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_basic_A', plan: 'basic', period: 'monthly',
    })

    const after = (await subs.get('acme'))!
    expect(after.plan).not.toBe('enterprise')
    expect(await subs.subscribed('acme', 'enterprise')).toBe(false)
    expect(await subs.features('acme').limit('seats')).toBeLessThan(500)
  })

  it('first-time customer: two checkouts then paying the cheap one never activates the expensive plan', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.checkout('acme', 'enterprise', checkoutUrls) // recorded as the incomplete plan
    await subs.checkout('acme', 'basic', checkoutUrls)
    await subs.checkout('acme', 'enterprise', checkoutUrls) // latest intent: enterprise again
    await subs.handleWebhook({
      id: 'evt_pay_basic', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_basic_1', plan: 'basic',
    })

    const after = (await subs.get('acme'))!
    expect(after).toMatchObject({ plan: 'basic', status: 'active', gatewayRef: 'sub_basic_1' })
    expect(await subs.subscribed('acme', 'enterprise')).toBe(false)
  })

  it('a paid period is honoured too: paying the monthly session never grants the yearly intent', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.subscribe('acme', 'basic')
    await subs.checkout('acme', 'enterprise', { ...checkoutUrls, period: 'monthly' })
    await subs.checkout('acme', 'enterprise', { ...checkoutUrls, period: 'yearly' })
    await subs.handleWebhook({
      id: 'evt_m', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_ent_m', plan: 'enterprise', period: 'monthly',
    })
    expect((await subs.get('acme'))!).toMatchObject({ plan: 'enterprise', period: 'monthly' })
  })

  it('without a gateway-attested plan, a new-ref payment never promotes a pending plan (fail closed)', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.subscribe('acme', 'basic')
    await subs.checkout('acme', 'basic', checkoutUrls)
    await subs.checkout('acme', 'enterprise', checkoutUrls)
    await subs.handleWebhook({ id: 'evt_noplan', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_new' })
    expect((await subs.get('acme'))!.plan).toBe('basic')
  })

  it('an attested plan that is not in the catalogue is ignored', async () => {
    const gateway = new FakeBillingGateway()
    const subs = new Subscriptions({ plans, gateway })
    await subs.checkout('acme', 'basic', checkoutUrls)
    await subs.handleWebhook({ id: 'evt_x', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_1', plan: 'platinum' })
    expect((await subs.get('acme'))!.plan).toBe('basic')
  })
})

describe('built-in drivers attest the PAID plan on webhooks (interleaved checkout, end to end)', () => {
  const NOW_MS = 1_700_000_000_000
  const hmac = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex')

  it('stripe: pay session A (basic) after starting session B (enterprise) → plan basic', async () => {
    const sessions: URLSearchParams[] = []
    let n = 0
    const gateway = new StripeBillingGateway({
      secretKey: 'sk_test',
      webhookSecret: 'whsec_test',
      priceId: (plan, period) => `price_${plan}_${period}`,
      customerId: (id) => `cus_${id}`,
      now: () => NOW_MS,
      fetch: async (_url, init) => {
        sessions.push(new URLSearchParams(String(init?.body)))
        return new Response(JSON.stringify({ id: `cs_${++n}`, url: `https://stripe.test/cs_${n}` }), { status: 200 })
      },
    })
    const subs = new Subscriptions({ plans, gateway })
    await subs.checkout('acme', 'basic', checkoutUrls) // A
    await subs.checkout('acme', 'enterprise', checkoutUrls) // B (abandoned)

    // Stripe copies the session's subscription metadata onto the invoice.
    const metaA = Object.fromEntries(
      [...sessions[0]!.entries()]
        .filter(([k]) => k.startsWith('subscription_data[metadata]'))
        .map(([k, v]) => [k.slice('subscription_data[metadata]['.length, -1), v]),
    )
    expect(metaA).toMatchObject({ billableId: 'acme', plan: 'basic', period: 'monthly' })
    const body = JSON.stringify({
      id: 'evt_A',
      type: 'invoice.paid',
      data: {
        object: {
          object: 'invoice',
          subscription: 'sub_A',
          subscription_details: { metadata: metaA },
          lines: { data: [{ price: { id: 'price_basic_monthly' }, proration: false }] },
        },
      },
    })
    const t = Math.floor(NOW_MS / 1000)
    const event = gateway.verifyWebhook(body, `t=${t},v1=${hmac('whsec_test', `${t}.${body}`)}`)!
    expect(event).toMatchObject({ billableId: 'acme', gatewayRef: 'sub_A', plan: 'basic', period: 'monthly' })

    await subs.handleWebhook(event)
    expect((await subs.get('acme'))!).toMatchObject({ plan: 'basic', status: 'active', gatewayRef: 'sub_A' })
    expect(await subs.subscribed('acme', 'enterprise')).toBe(false)
  })

  it('paddle: the transaction custom_data carries plan/period and the webhook surfaces them', () => {
    const gateway = new PaddleBillingGateway({
      apiKey: 'k', webhookSecret: 'ntfset_test', priceId: () => 'pri', customerId: (id) => id, now: () => NOW_MS,
    })
    const body = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        subscription_id: 'sub_1',
        custom_data: { billableId: 'acme', plan: 'basic', period: 'yearly' },
        items: [{ price: { id: 'pri' }, quantity: 1 }],
      },
    })
    const ts = Math.floor(NOW_MS / 1000)
    expect(gateway.verifyWebhook(body, `ts=${ts};h1=${hmac('ntfset_test', `${ts}:${body}`)}`)).toMatchObject({
      plan: 'basic',
      period: 'yearly',
    })
  })

  it('lemonsqueezy: the checkout custom data carries plan/period and the webhook surfaces them', () => {
    const gateway = new LemonSqueezyBillingGateway({
      apiKey: 'k', webhookSecret: 'ls_secret', storeId: '1', variantId: () => 'v',
    })
    const body = JSON.stringify({
      meta: { event_name: 'subscription_payment_success', custom_data: { billableId: 'acme', plan: 'basic', period: 'monthly' } },
      data: { id: '9', attributes: { subscription_id: 7, billing_reason: 'initial' } },
    })
    expect(gateway.verifyWebhook(body, hmac('ls_secret', body))).toMatchObject({ plan: 'basic', period: 'monthly', gatewayRef: '7' })
  })

  it('an unknown period value in metadata is not surfaced', () => {
    const gateway = new LemonSqueezyBillingGateway({ apiKey: 'k', webhookSecret: 's', storeId: '1', variantId: () => 'v' })
    const body = JSON.stringify({
      meta: { event_name: 'subscription_payment_success', custom_data: { billableId: 'acme', plan: 'basic', period: 'weekly' } },
      data: { id: '9', attributes: { subscription_id: 7 } },
    })
    expect(gateway.verifyWebhook(body, hmac('s', body))).not.toHaveProperty('period')
  })
})
