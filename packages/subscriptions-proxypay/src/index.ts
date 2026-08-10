import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  WebhookInvalidError,
  type PaymentEvent,
  type PaymentGateway,
  type PaymentInstruction,
  type PaymentRequest,
} from '@basaltkit/subscriptions'

/**
 * ProxyPay (https://developer.proxypay.co.ao) driver for the `@basaltkit/subscriptions`
 * `PaymentGateway` contract — reference-based payments over Multicaixa/EMIS in
 * Angola (AOA). The customer pays a **Reference** at an ATM, Multicaixa Express,
 * or a bank app using your account's fixed **Entity**; ProxyPay then POSTs a
 * `payment` webhook, which `verifyWebhook` translates to `payment.succeeded`.
 *
 * There's no card-on-file recurring charge — model recurring billing by creating
 * one payment (reference) per period.
 */

/** Minimal fetch surface — the global `fetch` (Node 18+/browsers) is assignable. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface ProxyPayOptions {
  /** API key — sent as `Authorization: Token <apiKey>`. */
  apiKey: string
  /** Your Multicaixa Entity (Entidade), assigned by ProxyPay/EMIS. */
  entity: string
  /** Use the sandbox host (`api.sandbox.proxypay.co.ao`). Default false (production). */
  sandbox?: boolean
  /** Override the base URL entirely. */
  baseUrl?: string
  /**
   * Shared secret to verify webhook signatures (HMAC-SHA256 of the raw body,
   * hex). Omit to skip verification (only if you secure the callback another way,
   * e.g. HTTP Basic auth on the URL). Configure the matching secret in ProxyPay.
   */
  webhookSecret?: string
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
}

export class ProxyPayRequestError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(`ProxyPay request failed (${httpStatus}): ${message}`)
    this.name = 'ProxyPayRequestError'
  }
}

const PROD = 'https://api.proxypay.co.ao'
const SANDBOX = 'https://api.sandbox.proxypay.co.ao'

export class ProxyPayGateway implements PaymentGateway {
  readonly name = 'proxypay'
  private readonly apiKey: string
  private readonly entity: string
  private readonly baseUrl: string
  private readonly webhookSecret: string | undefined
  private readonly fetchImpl: FetchLike

  constructor(options: ProxyPayOptions) {
    this.apiKey = options.apiKey
    this.entity = options.entity
    this.baseUrl = options.baseUrl ?? (options.sandbox ? SANDBOX : PROD)
    this.webhookSecret = options.webhookSecret
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!f) throw new Error('ProxyPayGateway: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Token ${this.apiKey}`,
        Accept: 'application/vnd.proxypay.v2+json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    if (!res.ok) throw new ProxyPayRequestError(res.status, text)
    return text ? JSON.parse(text) : undefined
  }

  /** Reserve the next available reference id from ProxyPay (POST /reference_ids). */
  private async reserveReferenceId(): Promise<string> {
    const r = await this.request('POST', '/reference_ids')
    // The endpoint returns the id (a number), or an array/object in some setups.
    if (typeof r === 'number' || typeof r === 'string') return String(r)
    if (Array.isArray(r) && r.length) return String(r[0])
    if (r && typeof r === 'object' && 'id' in r) return String((r as { id: unknown }).id)
    throw new ProxyPayRequestError(502, `unexpected /reference_ids response: ${JSON.stringify(r)}`)
  }

  async createPayment(request: PaymentRequest): Promise<PaymentInstruction> {
    const referenceId = await this.reserveReferenceId()
    const customFields: Record<string, string> = {
      billable_id: request.billableId,
      ...(request.reference ? { reference: request.reference } : {}),
      ...(request.metadata ?? {}),
    }
    await this.request('PUT', `/references/${referenceId}`, {
      amount: request.amount.toFixed(2),
      custom_fields: customFields,
      ...(request.expiresAt ? { end_datetime: new Date(request.expiresAt).toISOString() } : {}),
    })
    return {
      id: referenceId,
      status: 'pending',
      reference: { entity: this.entity, reference: referenceId, amount: request.amount },
    }
  }

  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null {
    if (this.webhookSecret) {
      const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')
      const a = Buffer.from(signature ?? '', 'utf8')
      const b = Buffer.from(expected, 'utf8')
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookInvalidError()
    }
    const payload = JSON.parse(rawBody) as {
      id?: string | number
      event_type?: string
      data?: {
        reference_id?: string | number
        amount?: string | number
        transaction_id?: string | number
        custom_fields?: Record<string, string>
      }
    }
    // ProxyPay emits a `payment` event when a reference is paid; nothing else acts on us.
    if (payload.event_type !== 'payment') return null
    const d = payload.data ?? {}
    return {
      id: String(payload.id ?? d.transaction_id ?? d.reference_id),
      type: 'payment.succeeded',
      paymentId: String(d.reference_id),
      amount: Number(d.amount),
      ...(d.custom_fields?.billable_id ? { billableId: d.custom_fields.billable_id } : {}),
      ...(d.custom_fields?.reference ? { reference: d.custom_fields.reference } : {}),
      raw: payload,
    }
  }

  // No status-poll method: ProxyPay confirms payment via the `payment` webhook
  // (see verifyWebhook), and `GET /references/{id}` 404s even for active,
  // unpaid references — so a poll can't reliably tell paid from pending.
}
