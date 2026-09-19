import { describe, expect, it } from 'vitest'
import {
  definePlans,
  FakeBillingGateway,
  MemorySubscriptionStore,
  Subscriptions,
  type BillingGateway,
  type SubscriptionRecord,
  type SwapInput,
} from '../src/index.js'

/**
 * B09/F14: subscription state transitions must be ordered. `canceled` is
 * terminal for the gateway subscription that was canceled — a late (or
 * re-delivered with a new id) payment event for the SAME subscription must not
 * revive it; only a NEW subscription (a new gateway ref from a fresh checkout)
 * can. And a local swap that raced a cancel must not overwrite the cancel.
 */

const plans = definePlans({
  basic: { price: 10, features: { seats: 5 } },
  enterprise: { price: 500, features: { seats: 500 } },
})
const urls = { successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' }

/** Returns detached copies, like a real database store (the memory store hands out its live object). */
class CopyingStore extends MemorySubscriptionStore {
  override async get(billableId: string): Promise<SubscriptionRecord | null> {
    const record = await super.get(billableId)
    return record ? structuredClone(record) : null
  }
}

async function activeViaCheckout(gateway: BillingGateway = new FakeBillingGateway()) {
  const subs = new Subscriptions({ plans, gateway, store: new CopyingStore() })
  await subs.checkout('acme', 'basic', urls)
  await subs.handleWebhook({ id: 'evt_1', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_1', plan: 'basic' })
  return subs
}

describe('canceled is terminal for the same gateway subscription', () => {
  it('a late payment.succeeded after subscription.canceled (same ref) does not revive access', async () => {
    const subs = await activeViaCheckout()
    await subs.handleWebhook({ id: 'evt_del', type: 'subscription.canceled', billableId: 'acme', gatewayRef: 'sub_1' })
    // Final invoice of an immediate cancel arrives AFTER the deletion event.
    await subs.handleWebhook({ id: 'evt_late_paid', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_1' })

    const after = (await subs.get('acme'))!
    expect(after.status).toBe('canceled')
    expect(await subs.subscribed('acme')).toBe(false)
  })

  it('a late ref-less payment.succeeded does not revive a canceled subscription either', async () => {
    const subs = await activeViaCheckout()
    await subs.cancel('acme', { atPeriodEnd: false })
    await subs.handleWebhook({ id: 'evt_noref', type: 'payment.succeeded', billableId: 'acme' })
    expect((await subs.get('acme'))!.status).toBe('canceled')
  })

  it('a late payment.failed does not rewrite canceled to past_due', async () => {
    const subs = await activeViaCheckout()
    await subs.handleWebhook({ id: 'evt_del', type: 'subscription.canceled', billableId: 'acme', gatewayRef: 'sub_1' })
    await subs.handleWebhook({ id: 'evt_fail', type: 'payment.failed', billableId: 'acme', gatewayRef: 'sub_1' })
    expect((await subs.get('acme'))!.status).toBe('canceled')
  })

  it('a NEW subscription (new ref from a fresh checkout) can reactivate the billable', async () => {
    const subs = await activeViaCheckout()
    await subs.handleWebhook({ id: 'evt_del', type: 'subscription.canceled', billableId: 'acme', gatewayRef: 'sub_1' })
    await subs.checkout('acme', 'enterprise', urls)
    await subs.handleWebhook({ id: 'evt_new', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_2', plan: 'enterprise' })
    expect((await subs.get('acme'))!).toMatchObject({ status: 'active', plan: 'enterprise', gatewayRef: 'sub_2' })
  })
})

describe('local swap racing a cancel', () => {
  it('a swap whose gateway call is in flight when an immediate cancel lands does not overwrite the cancel', async () => {
    let releaseSwap!: () => void
    const gateway = new (class extends FakeBillingGateway {
      override async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
        await new Promise<void>((resolve) => (releaseSwap = resolve))
        return super.swapSubscription(gatewayRef, input)
      }
    })()
    const subs = await activeViaCheckout(gateway)

    const swapping = subs.swap('acme', 'enterprise')
    await new Promise((r) => setTimeout(r, 0)) // swap has read the record and awaits the gateway
    await subs.cancel('acme', { atPeriodEnd: false })
    releaseSwap()
    // The swap lost the race: it reports that there is no live subscription.
    await expect(swapping).rejects.toMatchObject({ code: 'BILLING_SUBSCRIPTION_REQUIRED' })

    const after = (await subs.get('acme'))!
    expect(after.status).toBe('canceled')
    expect(await subs.subscribed('acme')).toBe(false)
  })
})
