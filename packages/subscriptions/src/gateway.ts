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
}

export interface CreateSubscriptionInput {
  billableId: string
  plan: string
  period: BillingPeriod
  price: number
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
}

/** Controllable in-process gateway — the test/dev driver. */
export class FakeBillingGateway implements BillingGateway {
  readonly name = 'fake'
  readonly created: CreateSubscriptionInput[] = []
  readonly canceled: { gatewayRef: string; atPeriodEnd: boolean }[] = []
  private counter = 0

  async createSubscription(input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    this.created.push(input)
    return { gatewayRef: `fake_sub_${++this.counter}` }
  }

  async cancelSubscription(gatewayRef: string, options: { atPeriodEnd: boolean }): Promise<void> {
    this.canceled.push({ gatewayRef, atPeriodEnd: options.atPeriodEnd })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent {
    if (signature !== 'valid') throw new WebhookInvalidError()
    return JSON.parse(rawBody) as WebhookEvent
  }
}
