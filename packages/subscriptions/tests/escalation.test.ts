import { describe, expect, it } from 'vitest'
import { definePlans, FakeBillingGateway, Subscriptions } from '../src/index.js'

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

    // Gateway confirms the NEW checkout — a different subscription ref.
    await subs.handleWebhook({ id: 'evt_upgrade', type: 'payment.succeeded', billableId: 'acme', gatewayRef: 'sub_ent_2' })

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
