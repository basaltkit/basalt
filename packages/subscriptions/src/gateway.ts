import { BasaltError } from '@basaltkit/core'
import type { BillingPeriod } from './plans.js'

export class WebhookInvalidError extends BasaltError {
  readonly status = 400
  constructor() {
    super('BILLING_WEBHOOK_INVALID', 'Webhook signature verification failed.')
  }
}

/**
 * Thrown when a gateway is asked to verify a webhook but no signing secret is
 * configured. Verification fails closed: an unauthenticated callback must never
 * be trusted (anyone could forge a `payment.succeeded`).
 */
export class WebhookSecretMissingError extends BasaltError {
  readonly status = 500
  constructor(gateway: string) {
    super(
      'BILLING_WEBHOOK_SECRET_MISSING',
      `${gateway}: cannot verify a webhook without a configured signing secret — refusing to trust an unsigned callback.`,
    )
  }
}

/**
 * Returns the configured webhook signing secret, or throws
 * WebhookSecretMissingError when it is absent, empty or whitespace — an empty
 * HMAC key is public knowledge, so "verifying" with it would accept forgeries.
 * Built-in drivers call this before every verification (fail closed).
 */
export function requireWebhookSecret(gateway: string, secret: string | undefined | null): string {
  if (typeof secret !== 'string' || secret.trim() === '') throw new WebhookSecretMissingError(gateway)
  return secret
}

/**
 * Reads the plan/period a driver stamped into the gateway's signed metadata when
 * it created the checkout/subscription — for `WebhookEvent.plan`/`period`.
 */
export function attestedPlan(
  metadata: Record<string, unknown> | null | undefined,
): { plan?: string; period?: BillingPeriod } {
  const plan = metadata?.['plan']
  const period = metadata?.['period']
  return {
    ...(typeof plan === 'string' && plan !== '' ? { plan } : {}),
    ...(period === 'monthly' || period === 'yearly' ? { period } : {}),
  }
}

/**
 * Like {@link attestedPlan}, but only attests a plan whose gateway price (or
 * variant) is among the prices the event actually CHARGED. Signed metadata is
 * stamped once, at checkout; the price of a gateway subscription can change
 * afterwards (a swap, or a plan change in the gateway's own portal) while the
 * metadata keeps naming the old plan. Binding the attestation to the charged
 * price stops a renewal of a cheap subscription from "attesting" an expensive
 * plan. No charged price, an unknown plan or a mismatch → nothing (fail closed).
 */
export function attestedPlanForPrice(
  metadata: Record<string, unknown> | null | undefined,
  charged: readonly string[],
  priceFor: (plan: string, period: BillingPeriod) => string,
): { plan?: string; period?: BillingPeriod } {
  const { plan, period } = attestedPlan(metadata)
  if (plan === undefined || charged.length === 0) return {}
  const periods: BillingPeriod[] = period !== undefined ? [period] : ['monthly', 'yearly']
  for (const candidate of periods) {
    let price: string
    try {
      price = priceFor(plan, candidate)
    } catch {
      continue
    }
    if (typeof price === 'string' && price !== '' && charged.includes(price)) {
      return { plan, period: candidate }
    }
  }
  return {}
}

/**
 * Thrown when a confirmed payment's amount does not match the amount that was
 * originally requested for that payment id — an underpayment, or a forged /
 * mis-routed callback trying to settle an invoice for less.
 */
export class PaymentAmountMismatchError extends BasaltError {
  readonly status = 400
  constructor(paymentId: string, expected: number, actual: number) {
    super(
      'BILLING_PAYMENT_AMOUNT_MISMATCH',
      `Payment ${paymentId} was requested for ${expected} but the webhook confirmed ${actual} — refusing to mark it paid.`,
    )
  }
}

/** Gateway-agnostic webhook event, already translated to domain terms. */
export interface WebhookEvent {
  /** Unique id at the gateway — used for idempotent processing. */
  id: string
  type: 'subscription.canceled' | 'payment.failed' | 'payment.succeeded'
  billableId: string
  /** Gateway subscription id, when the event carries one (e.g. after Checkout). */
  gatewayRef?: string
  /**
   * Plan that was actually PAID for, as attested by the gateway — read from the
   * signed metadata the driver attached when it created the checkout /
   * subscription (next to the price it charged). `handleWebhook` only changes
   * the local plan on a checkout confirmation when this is present and matches
   * the recorded intent, so interleaved checkouts cannot swap a cheap payment
   * for an expensive plan. Custom drivers should set it.
   */
  plan?: string
  /** Billing period that was paid for — same provenance as `plan`. */
  period?: BillingPeriod
}

export interface CreateSubscriptionInput {
  billableId: string
  plan: string
  period: BillingPeriod
  price: number
  /**
   * Trial length in days. When set, the gateway runs the trial and charges at
   * its end, driving the trial→active/past_due transition via webhook.
   */
  trialDays?: number
}

/** Input for a hosted Checkout session (the customer enters payment there). */
export interface CheckoutInput {
  billableId: string
  plan: string
  period: BillingPeriod
  successUrl: string
  cancelUrl: string
  trialDays?: number
}

/** Input for a Customer Portal session (self-service card/cancel management). */
export interface PortalInput {
  billableId: string
  returnUrl: string
}

/** Input for changing a subscription's plan mid-cycle with proration. */
export interface SwapInput {
  plan: string
  period: BillingPeriod
  /** How the gateway settles the mid-cycle difference. Default create_prorations. */
  prorationBehavior?: 'create_prorations' | 'none' | 'always_invoice'
}

/**
 * Payment gateway driver contract. The app talks to Basalt; only drivers
 * talk to Stripe/Paddle/Lemon Squeezy. A driver translates raw webhook
 * payloads into WebhookEvent — app code never sees gateway payloads.
 */
export interface BillingGateway {
  readonly name: string
  createSubscription(input: CreateSubscriptionInput): Promise<{ gatewayRef: string }>
  cancelSubscription(gatewayRef: string, options: { atPeriodEnd: boolean }): Promise<void>
  /**
   * Verifies the signature and translates the payload. Throws
   * WebhookInvalidError on a bad signature. Returns null for a verified event
   * the gateway doesn't map to a domain event (gateways emit many event types
   * we don't act on).
   */
  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null
  /** Hosted Checkout session — returns a URL to redirect the customer to. */
  createCheckoutSession?(input: CheckoutInput): Promise<{ url: string; id: string }>
  /** Customer Portal session — returns a URL for self-service billing. */
  createPortalSession?(input: PortalInput): Promise<{ url: string }>
  /** Changes the plan on an existing subscription, applying proration. */
  swapSubscription?(gatewayRef: string, input: SwapInput): Promise<void>
}

/** Controllable in-process gateway — the test/dev driver. */
export class FakeBillingGateway implements BillingGateway {
  readonly name = 'fake'
  readonly created: CreateSubscriptionInput[] = []
  readonly canceled: { gatewayRef: string; atPeriodEnd: boolean }[] = []
  readonly checkouts: CheckoutInput[] = []
  readonly portals: PortalInput[] = []
  readonly swaps: { gatewayRef: string; input: SwapInput }[] = []
  private counter = 0

  async createSubscription(input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    this.created.push(input)
    return { gatewayRef: `fake_sub_${++this.counter}` }
  }

  async cancelSubscription(gatewayRef: string, options: { atPeriodEnd: boolean }): Promise<void> {
    this.canceled.push({ gatewayRef, atPeriodEnd: options.atPeriodEnd })
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string; id: string }> {
    this.checkouts.push(input)
    const id = `fake_cs_${++this.counter}`
    return { url: `https://fake.test/checkout/${id}`, id }
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    this.portals.push(input)
    return { url: `https://fake.test/portal/${input.billableId}` }
  }

  async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
    this.swaps.push({ gatewayRef, input })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent {
    if (signature !== 'valid') throw new WebhookInvalidError()
    return JSON.parse(rawBody) as WebhookEvent
  }
}
