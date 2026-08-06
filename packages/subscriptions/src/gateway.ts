import { MachizeError } from '@machize/core'
import type { BillingPeriod } from './plans.js'

export class WebhookInvalidError extends MachizeError {
  readonly status = 400
  constructor() {
    super('BILLING_WEBHOOK_INVALID', 'Webhook signature verification failed.')
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
 * Payment gateway driver contract. The app talks to Machize; only drivers
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
