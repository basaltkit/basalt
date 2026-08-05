import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  definePlans,
  FakeBillingGateway,
  FeatureUnavailableError,
  meter,
  NotSubscribedError,
  QuotaExceededError,
  Subscriptions,
  UnknownPlanError,
} from '../src/index.js'

const plans = definePlans({
  free: { price: 0, features: { projects: 3, api: false } },
  pro: {
    price: { monthly: 29, yearly: 290 },
    trial: '14d',
    features: { projects: 50, api: true, 'api.requests': meter(1000) },
  },
  scale: { price: 'custom', features: { projects: Number.POSITIVE_INFINITY, api: true } },
})

const setup = (gateway?: FakeBillingGateway) =>
  new Subscriptions({ plans, fallbackPlan: 'free', ...(gateway ? { gateway } : {}) })

describe('Subscriptions lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('subscribe with trial: trialing now, expired after the trial window', async () => {
    const subscriptions = setup()
    await subscriptions.subscribe('acme', 'pro')

    expect(await subscriptions.onTrial('acme')).toBe(true)
    expect(await subscriptions.subscribed('acme')).toBe(true)
    expect(await subscriptions.subscribed('acme', 'pro')).toBe(true)
    expect(await subscriptions.subscribed('acme', 'scale')).toBe(false)

    vi.advanceTimersByTime(15 * 86_400_000)
    expect(await subscriptions.onTrial('acme')).toBe(false)
    expect(await subscriptions.subscribed('acme')).toBe(false)
  })

  it('expireTrials settles: free plan → active, paid plan → past_due', async () => {
    const subscriptions = new Subscriptions({
      plans: definePlans({
        starter: { price: 0, trial: '7d', features: {} },
        pro: { price: 29, trial: '7d', features: {} },
      }),
    })
    await subscriptions.subscribe('a', 'starter')
    await subscriptions.subscribe('b', 'pro')

    vi.advanceTimersByTime(8 * 86_400_000)
    const expired = await subscriptions.expireTrials()
    expect(expired.map((record) => [record.billableId, record.status])).toEqual([
      ['a', 'active'],
      ['b', 'past_due'],
    ])
  })

  it('swap and cancel (at period end vs immediate) and resume', async () => {
    const subscriptions = setup()
    await subscriptions.subscribe('acme', 'pro')

    const swapped = await subscriptions.swap('acme', 'scale')
    expect(swapped.plan).toBe('scale')

    const atEnd = await subscriptions.cancel('acme')
    expect(atEnd.cancelAtPeriodEnd).toBe(true)
    expect(await subscriptions.subscribed('acme')).toBe(true) // still active until period end

    await subscriptions.resume('acme')
    expect((await subscriptions.get('acme'))?.cancelAtPeriodEnd).toBe(false)

    const immediate = await subscriptions.cancel('acme', { atPeriodEnd: false })
    expect(immediate.status).toBe('canceled')
    expect(await subscriptions.subscribed('acme')).toBe(false)
    await expect(subscriptions.swap('acme', 'pro')).rejects.toBeInstanceOf(NotSubscribedError)
  })

  it('unknown plans fail fast', async () => {
    const subscriptions = setup()
    await expect(subscriptions.subscribe('acme', 'ghost')).rejects.toBeInstanceOf(UnknownPlanError)
    expect(() => new Subscriptions({ plans, fallbackPlan: 'ghost' })).toThrowError(UnknownPlanError)
  })
})

describe('gateway integration', () => {
  const gatewayPlans = definePlans({
    free: { price: 0, features: {} },
    pro: { price: 29, features: {} },
    trial: { price: 29, trial: '7d', features: {} },
  })

  it('paid plans go through the gateway (with trial_period when the plan has a trial); free does not', async () => {
    const gateway = new FakeBillingGateway()
    const subscriptions = new Subscriptions({ plans: gatewayPlans, gateway })

    await subscriptions.subscribe('a', 'free') // free → no gateway
    const trialing = await subscriptions.subscribe('b', 'trial') // paid + trial → gateway WITH trialDays
    const paid = await subscriptions.subscribe('c', 'pro', { period: 'monthly' }) // paid → gateway

    expect(gateway.created).toEqual([
      { billableId: 'b', plan: 'trial', period: 'monthly', price: 29, trialDays: 7 },
      { billableId: 'c', plan: 'pro', period: 'monthly', price: 29 },
    ])
    // the trialing sub is created at the gateway but locally still 'trialing'
    expect(trialing.status).toBe('trialing')
    expect(trialing.gatewayRef).toBe('fake_sub_1')
    expect(paid.gatewayRef).toBe('fake_sub_2')

    await subscriptions.cancel('c')
    expect(gateway.canceled).toEqual([{ gatewayRef: 'fake_sub_2', atPeriodEnd: true }])
  })

  it('gateway-backed trial converts through the webhook, not expireTrials', async () => {
    vi.useFakeTimers()
    try {
      const gateway = new FakeBillingGateway()
      const subscriptions = new Subscriptions({ plans: gatewayPlans, gateway })
      await subscriptions.subscribe('acme', 'trial')
      expect(await subscriptions.onTrial('acme')).toBe(true)

      // trial window passes; expireTrials must NOT settle a gateway-backed trial
      vi.advanceTimersByTime(8 * 86_400_000)
      expect(await subscriptions.expireTrials()).toEqual([])
      expect((await subscriptions.get('acme'))?.status).toBe('trialing')

      // the gateway charges at trial end and sends invoice.paid → active
      await subscriptions.handleWebhook({ id: 'evt_1', type: 'payment.succeeded', billableId: 'acme' })
      expect((await subscriptions.get('acme'))?.status).toBe('active')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('features', () => {
  it('flags, balances and unlimited', async () => {
    const subscriptions = setup()
    await subscriptions.subscribe('acme', 'pro')
    const features = subscriptions.features('acme')

    expect(await features.can('api')).toBe(true)
    expect(await features.limit('projects')).toBe(50)
    expect(await features.remaining('projects')).toBe(50)

    await features.consume('projects', 2)
    expect(await features.remaining('projects')).toBe(48)
    expect(await features.usage('projects')).toBe(2)
  })

  it('fallback plan applies to non-subscribers; denied features throw', async () => {
    const subscriptions = setup()
    const features = subscriptions.features('nobody')

    expect(await features.can('projects')).toBe(true) // free: 3
    expect(await features.can('api')).toBe(false) // free: false
    await expect(features.consume('api')).rejects.toBeInstanceOf(FeatureUnavailableError)
    await features.consume('projects', 3)
    await expect(features.consume('projects')).rejects.toBeInstanceOf(QuotaExceededError)
  })

  describe('meters reset per calendar month', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('quota is per month; a new month starts fresh', async () => {
      vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
      // no trial here — a trial would expire across the month boundary
      const subscriptions = new Subscriptions({
        plans: definePlans({
          pro: { price: 29, features: { 'api.requests': meter(1000) } },
        }),
      })
      await subscriptions.subscribe('acme', 'pro')
      const features = subscriptions.features('acme')

      await features.consume('api.requests', 1000)
      await expect(features.consume('api.requests')).rejects.toBeInstanceOf(QuotaExceededError)

      vi.setSystemTime(new Date('2026-09-01T00:00:01Z'))
      expect(await features.remaining('api.requests')).toBe(1000)
      await features.consume('api.requests', 5)
      expect(await features.usage('api.requests')).toBe(5)
    })
  })
})

describe('webhooks', () => {
  it('applies state changes idempotently and emits nothing twice', async () => {
    const subscriptions = setup()
    await subscriptions.subscribe('acme', 'pro')

    const event = { id: 'evt_1', type: 'payment.failed' as const, billableId: 'acme' }
    expect(await subscriptions.handleWebhook(event)).toBe(true)
    expect((await subscriptions.get('acme'))?.status).toBe('past_due')

    // gateway retry — deduplicated
    expect(await subscriptions.handleWebhook(event)).toBe(false)

    await subscriptions.handleWebhook({ id: 'evt_2', type: 'payment.succeeded', billableId: 'acme' })
    expect((await subscriptions.get('acme'))?.status).toBe('active')

    await subscriptions.handleWebhook({
      id: 'evt_3',
      type: 'subscription.canceled',
      billableId: 'acme',
    })
    expect((await subscriptions.get('acme'))?.status).toBe('canceled')
  })
})
