import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp, definePlugin, ensureMetadata } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import { EXPRESS, expressPlugin } from '@basaltkit/express'
import { FASTIFY, fastifyPlugin, type RequestEnricher } from '@basaltkit/fastify'
import { HONO, honoPlugin } from '@basaltkit/hono'
import type { AddressInfo } from 'node:net'
import {
  addInterval,
  billingWebhookRoute,
  Coupons,
  CouponInvalidError,
  CouponNotRedeemableError,
  definePlans,
  FakeBillingGateway,
  GatewayUnsupportedError,
  InvalidUsageAmountError,
  InvoiceInputError,
  Invoices,
  LemonSqueezyBillingGateway,
  MemorySubscriptionStore,
  MemoryUsageStore,
  meter,
  PaddleBillingGateway,
  PaymentLedger,
  PaymentRequiredError,
  QuotaExceededError,
  RedisUsageStore,
  renderInvoiceHtml,
  Subscriptions,
  subscriptionsPlugin,
  UnknownPlanError,
  type BillingGateway,
  type Invoice,
} from '../src/index.js'

/**
 * Regression tests for the framework audit, pass 2 (FA-046…FA-055, FA-071).
 * Each one asserts the FIXED behaviour of a defect the audit reproduced.
 */

const plans = () =>
  definePlans({
    free: { price: 0, features: { api: meter(10), seats: 3 } },
    pro: { price: { monthly: 4900, yearly: 49000 }, features: { api: meter(100_000), seats: 50 } },
    enterprise: { price: 'custom', features: { api: true, seats: true } },
  })

describe('FA-046 — swap() onto a paid plan needs a payment', () => {
  it('a local (no gatewayRef) free subscription cannot be swapped to a paid plan', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'free')
    await expect(s.swap('acme', 'pro')).rejects.toBeInstanceOf(PaymentRequiredError)
    await expect(s.swap('acme', 'enterprise')).rejects.toBeInstanceOf(PaymentRequiredError)
    expect((await s.get('acme'))?.plan).toBe('free')
    expect(await s.subscribed('acme', 'pro')).toBe(false)
  })

  it('same with a gateway configured: the free record has no gateway subscription to charge', async () => {
    const gateway = new FakeBillingGateway()
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.subscribe('acme', 'free')
    await expect(s.swap('acme', 'pro')).rejects.toBeInstanceOf(PaymentRequiredError)
    expect(gateway.swaps).toHaveLength(0)
  })

  it('allowUnpaid is the explicit escape hatch (payment collected elsewhere)', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'free')
    expect((await s.swap('acme', 'pro', { allowUnpaid: true })).plan).toBe('pro')
  })

  it('downgrading a local subscription to a free plan still works', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'pro')
    expect((await s.swap('acme', 'free')).plan).toBe('free')
  })

  it('a gateway-backed subscription whose gateway cannot swap is refused, not changed locally only', async () => {
    const gateway: BillingGateway = {
      name: 'noswap',
      createSubscription: async () => ({ gatewayRef: 'sub_1' }),
      cancelSubscription: async () => {},
      verifyWebhook: () => null,
    }
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.subscribe('acme', 'pro')
    await expect(s.swap('acme', 'free')).rejects.toBeInstanceOf(GatewayUnsupportedError)
    expect((await s.get('acme'))?.plan).toBe('pro')
  })
})

describe('FA-047 — usage amounts must be positive integers', () => {
  it('consume() rejects negative, zero, NaN, Infinity and fractions — the quota keeps binding', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'free')
    const f = s.features('acme')
    for (let i = 0; i < 10; i++) await f.consume('api')
    for (const bad of [-1000, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(f.consume('api', bad)).rejects.toBeInstanceOf(InvalidUsageAmountError)
    }
    expect(await f.remaining('api')).toBe(0)
    await expect(f.consume('api')).rejects.toBeInstanceOf(QuotaExceededError)
  })

  it('unlimited features reject bad amounts too', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'enterprise', {})
    await expect(s.features('acme').consume('api', -5)).rejects.toBeInstanceOf(InvalidUsageAmountError)
  })

  it('the memory store rejects them at store level', async () => {
    const store = new MemoryUsageStore()
    await expect(store.consume('a', 'f', 'p', -1, 10)).rejects.toBeInstanceOf(InvalidUsageAmountError)
    await expect(store.consume('a', 'f', 'p', Number.NaN, 10)).rejects.toBeInstanceOf(InvalidUsageAmountError)
    await expect(store.increment('a', 'f', 'p', -1)).rejects.toBeInstanceOf(InvalidUsageAmountError)
    expect(await store.get('a', 'f', 'p')).toBe(0)
  })

  it('the Redis store rejects them before any round trip', async () => {
    let calls = 0
    const store = new RedisUsageStore({
      get: async () => null,
      eval: async () => {
        calls++
        return [1, 0]
      },
    })
    await expect(store.consume('a', 'f', 'p', -1, 10)).rejects.toBeInstanceOf(InvalidUsageAmountError)
    await expect(store.increment('a', 'f', 'p', Number.NaN)).rejects.toBeInstanceOf(InvalidUsageAmountError)
    expect(calls).toBe(0)
  })
})

describe('FA-048 — a cancel/failure for ANOTHER gateway subscription does not touch the current one', () => {
  it('subscription.canceled for sub_OLD leaves the active sub_A alone', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'free')
    await s.handleWebhook({ id: 'e1', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_A' })
    await s.handleWebhook({ id: 'e2', type: 'subscription.canceled', billableId: 'acme', gatewayRef: 'sub_OLD' })
    const r = await s.get('acme')
    expect(r?.status).toBe('active')
    expect(r?.gatewayRef).toBe('sub_A')
  })

  it('payment.failed for sub_OLD does not make sub_A past_due', async () => {
    const gateway = new FakeBillingGateway()
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.subscribe('acme', 'pro') // fake_sub_1
    await s.handleWebhook({ id: 'e1', type: 'payment.failed', billableId: 'acme', gatewayRef: 'sub_OLD' })
    expect((await s.get('acme'))?.status).toBe('active')
  })

  it('a cancel for the subscription on file still cancels it', async () => {
    const gateway = new FakeBillingGateway()
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.subscribe('acme', 'pro')
    await s.handleWebhook({ id: 'e1', type: 'subscription.canceled', billableId: 'acme', gatewayRef: 'fake_sub_1' })
    expect((await s.get('acme'))?.status).toBe('canceled')
  })

  it('a cancel naming an untracked subscription does not cancel a local subscription', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'free')
    await s.handleWebhook({ id: 'e1', type: 'subscription.canceled', billableId: 'acme', gatewayRef: 'sub_X' })
    const r = await s.get('acme')
    expect(r?.status).toBe('active')
    expect(r?.gatewayRef).toBeUndefined()
  })
})

describe('FA-049 — plan and feature lookups use own keys only', () => {
  it('plan("constructor"/"__proto__"/"toString") throws UnknownPlanError', () => {
    const s = new Subscriptions({ plans: plans() })
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => s.plan(name)).toThrow(UnknownPlanError)
    }
  })

  it('subscribe() to a prototype key is refused', async () => {
    const s = new Subscriptions({ plans: plans() })
    await expect(s.subscribe('acme', 'constructor')).rejects.toBeInstanceOf(UnknownPlanError)
  })

  it('features("constructor") is not a feature', async () => {
    const s = new Subscriptions({ plans: plans() })
    await s.subscribe('acme', 'free')
    expect(await s.features('acme').can('constructor')).toBe(false)
  })
})

describe('FA-053 — billingWebhookRoute reads each driver\'s signature header', () => {
  const paddleRaw = JSON.stringify({
    event_id: 'evt_p1',
    event_type: 'subscription.canceled',
    data: { id: 'sub_p', custom_data: { billableId: 'acme' } },
  })
  const lsRaw = JSON.stringify({
    meta: { event_name: 'subscription_cancelled', custom_data: { billableId: 'acme' } },
    data: { type: 'subscriptions', id: 'sub_l', attributes: { updated_at: '2026-09-01T00:00:00Z' } },
  })
  const NOW = 1_700_000_000_000
  const paddle = new PaddleBillingGateway({
    apiKey: 'k',
    webhookSecret: 'pdl_secret',
    priceId: () => 'pri',
    customerId: () => 'ctm',
    now: () => NOW,
  })
  const lemon = new LemonSqueezyBillingGateway({
    apiKey: 'k',
    webhookSecret: 'ls_secret',
    storeId: '1',
    variantId: () => 'v',
  })
  const ts = Math.floor(NOW / 1000)
  const paddleSig = `ts=${ts};h1=${createHmac('sha256', 'pdl_secret').update(`${ts}:${paddleRaw}`).digest('hex')}`
  const lsSig = createHmac('sha256', 'ls_secret').update(lsRaw).digest('hex')

  type Post = (headers: Record<string, string>, body: string) => Promise<number>
  const boots: [string, (gateway: BillingGateway) => Promise<{ post: Post; close: () => Promise<void> }>][] = [
    [
      'fastify',
      async (gateway) => {
        const app = await createApp({
          plugins: [
            subscriptionsPlugin({ plans: plans() }),
            fastifyPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
          ],
        }).boot()
        const server = app.container.get(FASTIFY)
        return {
          post: async (headers, body) =>
            (await server.inject({ method: 'POST', url: '/billing/webhook', headers: { 'content-type': 'application/json', ...headers }, payload: body })).statusCode,
          close: () => app.shutdown(),
        }
      },
    ],
    [
      'express',
      async (gateway) => {
        const app = await createApp({
          plugins: [
            subscriptionsPlugin({ plans: plans() }),
            expressPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
          ],
        }).boot()
        const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
        await new Promise<void>((resolve) => server.once('listening', () => resolve()))
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        return {
          post: async (headers, body) =>
            (await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })).status,
          close: async () => {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
            await app.shutdown()
          },
        }
      },
    ],
    [
      'hono',
      async (gateway) => {
        const app = await createApp({
          plugins: [
            subscriptionsPlugin({ plans: plans() }),
            honoPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
          ],
        }).boot()
        const hono = app.container.get(HONO)
        return {
          post: async (headers, body) =>
            (
              await hono.fetch(
                new Request('http://local/billing/webhook', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', ...headers },
                  body,
                }),
                { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
              )
            ).status,
          close: () => app.shutdown(),
        }
      },
    ],
  ]

  describe.each(boots)('on %s', (_name, boot) => {
    it('Paddle deliveries (Paddle-Signature) are accepted', async () => {
      const { post, close } = await boot(paddle)
      try {
        expect(await post({ 'paddle-signature': paddleSig }, paddleRaw)).toBe(200)
        expect(await post({ 'paddle-signature': 'ts=1;h1=00' }, paddleRaw)).toBe(400)
      } finally {
        await close()
      }
    })

    it('Lemon Squeezy deliveries (X-Signature) are accepted', async () => {
      const { post, close } = await boot(lemon)
      try {
        expect(await post({ 'x-signature': lsSig }, lsRaw)).toBe(200)
        // the Stripe header is not where LS puts its signature
        expect(await post({ 'stripe-signature': lsSig }, lsRaw)).toBe(400)
      } finally {
        await close()
      }
    })
  })

  it('a gateway without signatureHeader keeps the legacy headers', async () => {
    const gateway = new FakeBillingGateway()
    const app = await createApp({
      plugins: [
        subscriptionsPlugin({ plans: plans(), gateway }),
        fastifyPlugin({ routes: [billingWebhookRoute(gateway)], onError: () => {} }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    const payload = JSON.stringify({ id: 'e', type: 'payment.failed', billableId: 'x' })
    const res = await server.inject({ method: 'POST', url: '/billing/webhook', headers: { 'content-type': 'application/json', 'x-billing-signature': 'valid' }, payload })
    expect(res.statusCode).toBe(200)
    await app.shutdown()
  })
})

describe('FA-054 — resume() withdraws the cancellation at the gateway', () => {
  it('calls resumeSubscription for a gateway-backed subscription canceled at period end', async () => {
    const gateway = new FakeBillingGateway()
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.subscribe('acme', 'pro')
    await s.cancel('acme')
    const r = await s.resume('acme')
    expect(gateway.resumed).toEqual(['fake_sub_1'])
    expect(r.cancelAtPeriodEnd).toBe(false)
  })

  it('refuses (instead of drifting) when the gateway cannot resume', async () => {
    const gateway: BillingGateway = {
      name: 'noresume',
      createSubscription: async () => ({ gatewayRef: 'sub_1' }),
      cancelSubscription: async () => {},
      verifyWebhook: () => null,
    }
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.subscribe('acme', 'pro')
    await s.cancel('acme')
    await expect(s.resume('acme')).rejects.toBeInstanceOf(GatewayUnsupportedError)
    expect((await s.get('acme'))?.cancelAtPeriodEnd).toBe(true)
  })

  it('a Paddle checkout learns the real subscription id, which cancel() then addresses', async () => {
    const calls: string[] = []
    const fetchMock = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ data: { id: 'txn_1', checkout: { url: 'https://pay/x' } } }))
    }) as typeof fetch
    const gateway = new PaddleBillingGateway({
      apiKey: 'k',
      webhookSecret: 's',
      priceId: (plan, period) => `pri_${plan}_${period}`,
      customerId: () => 'ctm',
      fetch: fetchMock,
    })
    const s = new Subscriptions({ plans: plans(), gateway })
    await s.checkout('acme', 'pro', { successUrl: 'https://a/ok', cancelUrl: 'https://a/no' })
    await s.handleWebhook({ id: 'evt_1', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_real', plan: 'pro' })
    expect((await s.get('acme'))?.gatewayRef).toBe('sub_real')
    await s.cancel('acme')
    expect(calls.at(-1)).toBe('https://api.paddle.com/subscriptions/sub_real/cancel')
  })
})

describe('FA-055 — coupons', () => {
  it('redeem() enforces maxRedemptions', async () => {
    const coupons = new Coupons()
    await coupons.define({ code: 'ONE', percentOff: 10, maxRedemptions: 1 })
    await coupons.redeem('ONE')
    await expect(coupons.redeem('ONE')).rejects.toBeInstanceOf(CouponNotRedeemableError)
    expect((await coupons.get('ONE'))?.redemptions).toBe(1)
  })

  it('two concurrent redemptions of the last slot: exactly one wins', async () => {
    const coupons = new Coupons()
    await coupons.define({ code: 'LAST', percentOff: 10, maxRedemptions: 1 })
    const results = await Promise.allSettled([coupons.redeem('LAST'), coupons.redeem('LAST')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await coupons.get('LAST'))?.redemptions).toBe(1)
  })

  it('redeem() enforces redeemBy', async () => {
    let now = 1_000
    const coupons = new Coupons({ now: () => now })
    await coupons.define({ code: 'EXP', percentOff: 10, redeemBy: 2_000 })
    now = 3_000
    await expect(coupons.redeem('EXP')).rejects.toBeInstanceOf(CouponNotRedeemableError)
  })

  it('percentOff NaN / non-integer maxRedemptions are invalid shapes', async () => {
    const coupons = new Coupons()
    await expect(coupons.define({ code: 'NAN', percentOff: Number.NaN })).rejects.toBeInstanceOf(CouponInvalidError)
    await expect(coupons.define({ code: 'M', percentOff: 5, maxRedemptions: Number.NaN })).rejects.toBeInstanceOf(
      CouponInvalidError,
    )
    await expect(coupons.define({ code: 'M2', percentOff: 5, maxRedemptions: 1.5 })).rejects.toBeInstanceOf(
      CouponInvalidError,
    )
  })
})

describe('FA-055 — invoices', () => {
  const line = { description: 'Seat', unitAmount: 1000 }

  it('rejects negative, fractional or NaN quantities', async () => {
    const invoices = new Invoices()
    for (const quantity of [-5, 0, 1.5, Number.NaN]) {
      await expect(
        invoices.draft({ billableId: 'a', currency: 'USD', lineItems: [{ ...line, quantity }] }),
      ).rejects.toBeInstanceOf(InvoiceInputError)
    }
  })

  it('rejects a negative or NaN tax/discount instead of lowering the total', async () => {
    const invoices = new Invoices()
    const base = { billableId: 'a', currency: 'USD', lineItems: [line] }
    await expect(invoices.draft({ ...base, tax: -500 })).rejects.toBeInstanceOf(InvoiceInputError)
    await expect(invoices.draft({ ...base, tax: { rate: -0.5 } })).rejects.toBeInstanceOf(InvoiceInputError)
    await expect(invoices.draft({ ...base, tax: Number.NaN })).rejects.toBeInstanceOf(InvoiceInputError)
    await expect(invoices.draft({ ...base, discount: Number.NaN })).rejects.toBeInstanceOf(InvoiceInputError)
    expect(() => new Invoices({ taxRate: -0.1 })).toThrow(InvoiceInputError)
    const ok = await invoices.draft({ ...base, tax: 140 })
    expect(ok.total).toBe(1140)
  })

  it('rejects a currency that is not an ISO 4217 code', async () => {
    const invoices = new Invoices()
    await expect(
      invoices.draft({ billableId: 'a', currency: '<img src=x onerror=alert(1)>', lineItems: [line] }),
    ).rejects.toBeInstanceOf(InvoiceInputError)
  })

  it('renderInvoiceHtml escapes a hostile stored currency (Intl fallback path)', () => {
    const invoice: Invoice = {
      id: 'i',
      number: 'INV-1',
      billableId: 'a',
      currency: '<script>alert(1)</script>',
      status: 'open',
      lineItems: [{ description: 'x', quantity: 1, unitAmount: 100, amount: 100 }],
      subtotal: 100,
      discount: 0,
      tax: 0,
      total: 100,
      amountPaid: 0,
      amountDue: 100,
      createdAt: 0,
    }
    const html = renderInvoiceHtml(invoice)
    expect(html).not.toContain('<SCRIPT>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;SCRIPT&gt;')
  })
})

describe('FA-055 — PaymentLedger state machine', () => {
  const req = { billableId: 'acme', amount: 5000 }

  it('a late payment.failed does not un-pay a paid payment', async () => {
    const ledger = new PaymentLedger()
    await ledger.created({ id: 'p1', status: 'pending' }, req)
    await ledger.apply({ id: 'e1', type: 'payment.succeeded', paymentId: 'p1', amount: 5000 })
    const late = await ledger.apply({ id: 'e2', type: 'payment.failed', paymentId: 'p1', amount: 0 })
    expect(late.fresh).toBe(false)
    expect((await ledger.get('p1'))?.status).toBe('paid')
  })

  it('a second payment.succeeded under a new event id does not run onFresh twice', async () => {
    const ledger = new PaymentLedger()
    await ledger.created({ id: 'p1', status: 'pending' }, req)
    let activations = 0
    const onFresh = () => {
      activations++
    }
    await ledger.apply({ id: 'e1', type: 'payment.succeeded', paymentId: 'p1', amount: 5000 }, onFresh)
    const again = await ledger.apply({ id: 'e1-bis', type: 'payment.succeeded', paymentId: 'p1', amount: 5000 }, onFresh)
    expect(again.fresh).toBe(false)
    expect(activations).toBe(1)
  })

  it('failed → paid (a retry that succeeds) still applies', async () => {
    const ledger = new PaymentLedger()
    await ledger.created({ id: 'p1', status: 'pending' }, req)
    await ledger.apply({ id: 'e1', type: 'payment.failed', paymentId: 'p1', amount: 5000 })
    const ok = await ledger.apply({ id: 'e2', type: 'payment.succeeded', paymentId: 'p1', amount: 5000 })
    expect(ok.fresh).toBe(true)
    expect(ok.record?.status).toBe('paid')
  })

  it('a failure reporting amount 0 does not erase the requested amount (underpayment check stays armed)', async () => {
    const ledger = new PaymentLedger()
    await ledger.created({ id: 'p1', status: 'pending' }, req)
    await ledger.apply({ id: 'e1', type: 'payment.failed', paymentId: 'p1', amount: 0 })
    expect((await ledger.get('p1'))?.amount).toBe(5000)
    await expect(
      ledger.apply({ id: 'e2', type: 'payment.succeeded', paymentId: 'p1', amount: 1 }),
    ).rejects.toThrow(/requested for 5000/)
  })
})

describe('FA-071 — meta.feature must name a feature (S-9)', () => {
  const tenancy = definePlugin({
    name: 'fake-tenancy',
    register({ container }) {
      const enricher: RequestEnricher = ({ context }) => {
        context.tenant = { id: 'acme' }
      }
      ensureMetadata(container).add('http:enrichers', enricher)
    },
  })

  it('a non-string or empty meta.feature fails closed (403) instead of being skipped', async () => {
    const app = await createApp({
      plugins: [
        tenancy,
        subscriptionsPlugin({ plans: plans(), fallbackPlan: 'free' }),
        fastifyPlugin({
          routes: [
            route({ method: 'GET', url: '/bool', meta: { feature: true as never }, handler: () => ({ ok: true }) }),
            route({ method: 'GET', url: '/arr', meta: { feature: ['api'] as never }, handler: () => ({ ok: true }) }),
            route({ method: 'GET', url: '/empty', meta: { feature: '' }, handler: () => ({ ok: true }) }),
            route({ method: 'GET', url: '/ok', meta: { feature: 'api' }, handler: () => ({ ok: true }) }),
          ],
        }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)
    expect((await server.inject({ method: 'GET', url: '/bool' })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: '/arr' })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: '/empty' })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: '/ok' })).statusCode).toBe(200)
    await app.shutdown()
  })
})

describe('FA-071 — clocks and periods (S-17)', () => {
  it('Subscriptions takes an injectable clock (trials, meters)', async () => {
    let now = Date.UTC(2026, 0, 31, 23, 0)
    const s = new Subscriptions({
      plans: definePlans({ t: { price: 0, trial: '1d', features: { api: meter(5) } } }),
      now: () => now,
    })
    await s.subscribe('acme', 't')
    expect(await s.onTrial('acme')).toBe(true)
    await s.features('acme').consume('api', 5)
    now += 2 * 86_400_000 // February: the meter bucket rolls over, the trial is over
    expect(await s.onTrial('acme')).toBe(false)
    const [expired] = await s.expireTrials()
    expect(expired?.status).toBe('active')
    expect(await s.features('acme').remaining('api')).toBe(5)
  })

  it('expireTrials does not abort on a plan removed from the catalogue', async () => {
    let now = 0
    const store = new MemorySubscriptionStore()
    await store.save({ billableId: 'gone', plan: 'removed', period: 'monthly', status: 'trialing', trialEndsAt: 1 })
    await store.save({ billableId: 'kept', plan: 'free', period: 'monthly', status: 'trialing', trialEndsAt: 1 })
    const s = new Subscriptions({ plans: plans(), store, now: () => now })
    now = 10
    const expired = await s.expireTrials()
    expect(expired.map((r) => [r.billableId, r.status])).toEqual([
      ['gone', 'past_due'],
      ['kept', 'active'],
    ])
  })

  it('addInterval is UTC and clamps to the end of the month', () => {
    const iso = (ms: number) => new Date(ms).toISOString()
    expect(iso(addInterval(Date.UTC(2026, 0, 31, 12), 'monthly'))).toBe('2026-02-28T12:00:00.000Z')
    expect(iso(addInterval(Date.UTC(2028, 0, 31), 'monthly'))).toBe('2028-02-29T00:00:00.000Z')
    expect(iso(addInterval(Date.UTC(2028, 1, 29), 'yearly'))).toBe('2029-02-28T00:00:00.000Z')
    expect(iso(addInterval(Date.UTC(2026, 11, 15), 'monthly'))).toBe('2027-01-15T00:00:00.000Z')
  })
})
