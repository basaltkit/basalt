import { WebhookInvalidError } from './gateway.js'

/**
 * One-off / reference / mobile-money payments — the model used by Angolan
 * providers (ProxyPay, EMIS/Multicaixa, AppyPay, UNITEL Money), where there's no
 * card-on-file recurring charge or self-service portal. This complements
 * `BillingGateway` (card subscriptions). Recurring billing is modelled by
 * creating one payment per period (invoice → reference → webhook confirms → the
 * period is activated).
 */

/** A one-off payment request handed to a `PaymentGateway`. */
export interface PaymentRequest {
  /** Who is paying — a tenant/user/customer id you reconcile against. */
  billableId: string
  /** Amount in the currency's major unit (e.g. 5000 = 5000,00 Kz). */
  amount: number
  /** ISO 4217. Defaults to the gateway's own (AOA for Angolan gateways). */
  currency?: string
  /** Your order/invoice id — for idempotency and reconciliation. */
  reference?: string
  description?: string
  customer?: { name?: string; email?: string; phone?: string }
  /** When the reference / request stops being payable (epoch ms). */
  expiresAt?: number
  /** Passed to the gateway and echoed back on the webhook. */
  metadata?: Record<string, string>
}

/** How the customer is told to pay — a reference, a redirect, or a push. */
export interface PaymentInstruction {
  /** The gateway's id for this payment (status checks + reconciliation). */
  id: string
  status: 'pending' | 'paid' | 'failed'
  /** Reference-based (Multicaixa/EMIS): the entity + reference to pay. */
  reference?: { entity: string; reference: string; amount: number }
  /** Redirect-based (hosted page): send the customer here. */
  url?: string
  /** Push-based (mobile money): a prompt was sent to this phone. */
  push?: { phone: string }
  /** The raw gateway payload, for logging/debugging. */
  raw?: unknown
}

/** A payment webhook, translated to domain terms — gateway payloads never leak. */
export interface PaymentEvent {
  /** Unique id at the gateway — for idempotent processing. */
  id: string
  type: 'payment.succeeded' | 'payment.failed'
  /** The gateway payment/reference id from `createPayment`. */
  paymentId: string
  amount: number
  /** From the request metadata, when the gateway echoes it back. */
  billableId?: string
  reference?: string
  raw?: unknown
}

/**
 * Payment gateway driver contract for one-off / reference / mobile-money
 * charges. The app talks to Basalt; only drivers talk to ProxyPay / EMIS / etc.
 * A driver translates raw webhook payloads into `PaymentEvent`.
 */
export interface PaymentGateway {
  readonly name: string
  /** Create a payment — returns a reference, a redirect URL, or a push. */
  createPayment(request: PaymentRequest): Promise<PaymentInstruction>
  /**
   * Verifies the signature and translates the payload. Throws
   * `WebhookInvalidError` on a bad signature; returns null for a verified event
   * that isn't a payment (gateways emit event types we don't act on).
   */
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null
  /** Poll a payment's status — a fallback when you can't receive webhooks. */
  getPayment?(id: string): Promise<PaymentInstruction>
}

/** Controllable in-process payment gateway — the test/dev driver. */
export class FakePaymentGateway implements PaymentGateway {
  readonly name = 'fake'
  readonly payments: PaymentRequest[] = []
  private counter = 0

  async createPayment(request: PaymentRequest): Promise<PaymentInstruction> {
    this.payments.push(request)
    const id = `fake_pay_${++this.counter}`
    return { id, status: 'pending', reference: { entity: '00000', reference: id, amount: request.amount } }
  }

  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent {
    if (signature !== 'valid') throw new WebhookInvalidError()
    return JSON.parse(rawBody) as PaymentEvent
  }
}
