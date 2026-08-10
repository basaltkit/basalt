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
 *
 * The `payment` callback is a **flat** JSON object (the same shape as an item in
 * `GET /payments`): top-level `reference_id`, `amount`, `id`, `custom_fields` —
 * signed with HMAC-SHA256 in the `x-signature` header. `verifyWebhook` validates
 * it and returns a `payment.succeeded` event.
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
   * Secret used to verify webhook signatures — HMAC-SHA256 of the raw request
   * body, hex-encoded, delivered in the `x-signature` header. **Defaults to your
   * API key**, which is what ProxyPay signs the callback with, so verification is
   * on out of the box. Override only if you configured a different secret; pass
   * an empty string (`''`) to disable verification entirely.
   */
  webhookSecret?: string
  /**
   * Optional callback URL echoed back on the webhook as `custom_fields.callback_url`.
   * ProxyPay's delivery target is normally set account-wide in the dashboard; this
   * just tags each reference so the payload carries the URL. Per-reference callers
   * can also pass it through `PaymentRequest.metadata`.
   */
  callbackUrl?: string
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
  private readonly callbackUrl: string | undefined
  private readonly fetchImpl: FetchLike

  constructor(options: ProxyPayOptions) {
    this.apiKey = options.apiKey
    this.entity = options.entity
    this.baseUrl = options.baseUrl ?? (options.sandbox ? SANDBOX : PROD)
    // ProxyPay signs the callback with the API key; default to it so verification
    // is on unless the caller explicitly opts out with webhookSecret: ''.
    this.webhookSecret = options.webhookSecret ?? options.apiKey
    this.callbackUrl = options.callbackUrl
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
    // Honor a caller-supplied reference (e.g. an external order id) and skip the
    // extra `POST /reference_ids` round-trip; otherwise reserve one from ProxyPay.
    const referenceId = request.reference ?? (await this.reserveReferenceId())
    const customFields: Record<string, string> = {
      billable_id: request.billableId,
      ...(request.reference ? { reference: request.reference } : {}),
      ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
      ...(request.metadata ?? {}),
    }
    await this.request('PUT', `/references/${referenceId}`, {
      // ProxyPay's v2 API expects `amount` as a JSON number, not a string.
      amount: Number(request.amount.toFixed(2)),
      custom_fields: customFields,
      // `end_datetime` is a date (YYYY-MM-DD); sending a full ISO datetime can be
      // rejected and `toISOString()` would also shift the day into UTC.
      ...(request.expiresAt
        ? { end_datetime: new Date(request.expiresAt).toISOString().slice(0, 10) }
        : {}),
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
    // ProxyPay POSTs a FLAT payment object when a reference is paid — the same
    // shape as an item in `GET /payments`: top-level `reference_id`, `amount`,
    // `id`, `custom_fields`. There is no `event_type` and no nested `data`.
    const payload = JSON.parse(rawBody) as {
      id?: string | number
      reference_id?: string | number
      amount?: string | number
      transaction_id?: string | number
      datetime?: string
      custom_fields?: Record<string, string>
    }
    // Not a payment callback (no reference id) — ignore.
    if (payload.reference_id == null) return null
    const cf = payload.custom_fields ?? {}
    return {
      id: String(payload.id ?? payload.transaction_id ?? payload.reference_id),
      type: 'payment.succeeded',
      paymentId: String(payload.reference_id),
      amount: Number(payload.amount),
      ...(cf.billable_id ? { billableId: cf.billable_id } : {}),
      ...(cf.reference ? { reference: cf.reference } : {}),
      raw: payload,
    }
  }

  // No status-poll method: ProxyPay confirms payment via the flat `payment`
  // callback (see verifyWebhook), and `GET /references/{id}` 404s even for active,
  // unpaid references — so a poll can't reliably tell paid from pending.
}
