import { WebhookInvalidError } from './gateway.js'
import { MemoryWebhookStore, type WebhookStore } from './stores.js'

/**
 * One-off / reference / mobile-money payments — the model used by Angolan
 * providers (ProxyPay, EMIS/Multicaixa, AppyPay, UNITEL Money), where there's no
 * card-on-file recurring charge or self-service portal. This complements
 * `BillingGateway` (card subscriptions). Recurring billing is modelled by
 * creating one payment per period (invoice → reference → webhook confirms → the
 * period is activated).
 *
 * **All amounts are integers in the currency's minor unit** (cents; `100 = 1.00`)
 * — the Stripe convention. Use the `money` helpers (`toMinor`/`formatMoney`) at
 * the human boundary. Drivers translate to each provider's expected format.
 */

/** A one-off payment request handed to a `PaymentGateway`. */
export interface PaymentRequest {
  /** Who is paying — a tenant/user/customer id you reconcile against. */
  billableId: string
  /** Amount in the currency's minor unit (integer; `500000` = 5.000,00 Kz). */
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

export type PaymentRecordStatus = 'pending' | 'paid' | 'failed'

/** A payment as tracked in your app's ledger, keyed by the gateway payment id. */
export interface PaymentRecord {
  /** Gateway payment id — `PaymentInstruction.id` / `PaymentEvent.paymentId`. */
  id: string
  status: PaymentRecordStatus
  amount: number
  billableId?: string
  reference?: string
  /** Epoch ms. */
  createdAt: number
  updatedAt: number
  raw?: unknown
}

/** Input to record a freshly-created (pending) payment. */
export interface NewPayment {
  id: string
  amount: number
  billableId?: string
  reference?: string
  raw?: unknown
}

/**
 * A ledger of payments keyed by the gateway payment id. Apps record a payment
 * as `pending` on `createPayment` and let the webhook flip it to `paid`/`failed`
 * — no more hand-rolling this per app. A memory implementation ships here; back
 * it with your database in production (a `Payment` table keyed by `id`).
 */
export interface PaymentStore {
  /** Insert a pending payment. Idempotent: a no-op if the id already exists. */
  create(payment: NewPayment): Promise<void>
  /** Apply a terminal status; upserts if the payment wasn't recorded first. */
  setStatus(
    id: string,
    status: PaymentRecordStatus,
    patch?: { amount?: number; raw?: unknown },
  ): Promise<void>
  get(id: string): Promise<PaymentRecord | undefined>
}

/** In-memory `PaymentStore` — per-process; swap for a durable one in production. */
export class MemoryPaymentStore implements PaymentStore {
  private readonly records = new Map<string, PaymentRecord>()

  async create(payment: NewPayment): Promise<void> {
    if (this.records.has(payment.id)) return
    const now = Date.now()
    this.records.set(payment.id, {
      id: payment.id,
      status: 'pending',
      amount: payment.amount,
      ...(payment.billableId ? { billableId: payment.billableId } : {}),
      ...(payment.reference ? { reference: payment.reference } : {}),
      createdAt: now,
      updatedAt: now,
      ...(payment.raw !== undefined ? { raw: payment.raw } : {}),
    })
  }

  async setStatus(
    id: string,
    status: PaymentRecordStatus,
    patch: { amount?: number; raw?: unknown } = {},
  ): Promise<void> {
    const now = Date.now()
    const rec: PaymentRecord = this.records.get(id) ?? {
      id,
      status,
      amount: patch.amount ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    rec.status = status
    rec.updatedAt = now
    if (patch.amount != null) rec.amount = patch.amount
    if (patch.raw !== undefined) rec.raw = patch.raw
    this.records.set(id, rec)
  }

  async get(id: string): Promise<PaymentRecord | undefined> {
    return this.records.get(id)
  }
}

/** Result of applying a `PaymentEvent` to the ledger. */
export interface PaymentApplyResult {
  /** false = this event id was already processed (deduped) — you did nothing. */
  fresh: boolean
  record?: PaymentRecord
}

export interface PaymentLedgerOptions {
  /** Where payments are stored. Default: in-memory. */
  store?: PaymentStore
  /**
   * Webhook-id dedupe store. Default: in-memory. Share one durable store (e.g.
   * Redis) across the app so a retried callback is applied exactly once.
   */
  webhooks?: WebhookStore
}

/**
 * Ties a `PaymentStore` to webhook idempotency so a retried callback is applied
 * once. Record a payment on create, then feed every verified `PaymentEvent`
 * through `apply` — it dedupes by `event.id` and updates the ledger.
 *
 * ```ts
 * const ledger = new PaymentLedger()
 * const inst = await gateway.createPayment(req)
 * await ledger.created(inst, req)              // pending
 * // in the webhook route:
 * const event = gateway.verifyWebhook(raw, sig)
 * if (event) {
 *   const { fresh, record } = await ledger.apply(event)
 *   if (fresh && record?.status === 'paid') activate(record.billableId!)
 * }
 * ```
 */
export class PaymentLedger {
  private readonly store: PaymentStore
  private readonly webhooks: WebhookStore

  constructor(options: PaymentLedgerOptions = {}) {
    this.store = options.store ?? new MemoryPaymentStore()
    this.webhooks = options.webhooks ?? new MemoryWebhookStore()
  }

  /** Record a just-created payment as pending. Call after `createPayment`. */
  async created(instruction: PaymentInstruction, request: PaymentRequest): Promise<void> {
    await this.store.create({
      id: instruction.id,
      amount: request.amount,
      ...(request.billableId ? { billableId: request.billableId } : {}),
      ...(request.reference ? { reference: request.reference } : {}),
      ...(instruction.raw !== undefined ? { raw: instruction.raw } : {}),
    })
  }

  /**
   * Apply a verified `PaymentEvent` idempotently. Dedupes by `event.id`; on a
   * fresh event, flips the ledger record to paid/failed. If persisting fails the
   * dedupe claim is released so the gateway's retry can reprocess.
   *
   * `onFresh` runs **inside the idempotency claim**, after the ledger is
   * updated — use it for domain side effects (activate a subscription, mark a
   * booking paid) that must apply exactly once with the payment. If it throws,
   * the claim is released so the whole thing reprocesses on the gateway's retry.
   */
  async apply(
    event: PaymentEvent,
    onFresh?: (record: PaymentRecord | undefined, event: PaymentEvent) => Promise<void> | void,
  ): Promise<PaymentApplyResult> {
    const fresh = await this.webhooks.markProcessed(event.id)
    if (!fresh) return { fresh: false }
    try {
      const status: PaymentRecordStatus = event.type === 'payment.succeeded' ? 'paid' : 'failed'
      await this.store.setStatus(event.paymentId, status, {
        amount: event.amount,
        ...(event.raw !== undefined ? { raw: event.raw } : {}),
      })
      const record = await this.store.get(event.paymentId)
      if (onFresh) await onFresh(record, event)
      return { fresh: true, ...(record ? { record } : {}) }
    } catch (error) {
      await this.webhooks.release(event.id)
      throw error
    }
  }

  get(id: string): Promise<PaymentRecord | undefined> {
    return this.store.get(id)
  }
}
