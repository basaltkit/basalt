import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  assertMinorUnits,
  toMajor,
  toMinor,
  WebhookInvalidError,
  WebhookSecretMissingError,
  type PaymentEvent,
  type PaymentGateway,
  type PaymentInstruction,
  type PaymentRequest,
} from '@basaltkit/subscriptions'

/**
 * AppyPay (https://www.appypay.co.ao) driver for the `@basaltkit/subscriptions`
 * `PaymentGateway` contract. Unlike ProxyPay (reference-only), AppyPay covers
 * several methods over EMIS/Multicaixa in Angola (AOA):
 *
 *  - **express**   — Multicaixa Express: a push prompt to the customer's phone
 *                    (returns `PaymentInstruction.push`).
 *  - **reference** — a Multicaixa reference to pay at an ATM/app
 *                    (returns `PaymentInstruction.reference`).
 *  - **card**      — a hosted card page (returns `PaymentInstruction.url`).
 *
 * Auth is OAuth2 client-credentials: the driver fetches and caches a bearer
 * token, then calls the charges API.
 *
 * ⚠️ PRE-RELEASE. The AppyPay-specific wire details (token/charge URLs, request
 * and response field names, the payment-method enum, and the webhook signature
 * scheme) are grouped in the `WIRE` block and marked `TODO(verify)`. They are
 * plausible defaults that MUST be confirmed against the AppyPay sandbox before
 * this driver is published. The PaymentGateway mapping, token caching and HMAC
 * verification are provider-agnostic and stable.
 */

/** Minimal fetch surface — the global `fetch` (Node 18+/browsers) is assignable. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type AppyPayMethod = 'express' | 'reference' | 'card'

/**
 * AppyPay-specific wire details. **Everything here is `TODO(verify)`** against
 * the live AppyPay API — kept in one place so validation is a single edit.
 */
const WIRE = {
  /** Charges endpoint (relative to baseUrl). TODO(verify). */
  chargesPath: '/v1.0/charges',
  /** Payment-method enum sent on a charge. TODO(verify) exact values. */
  method: {
    express: 'GPO_MULTICAIXA_EXPRESS',
    reference: 'GPO_REFERENCE',
    card: 'GPO_VISA',
  } as Record<AppyPayMethod, string>,
  /** OAuth2 token response fields. TODO(verify). */
  token: { access: 'access_token', expiresIn: 'expires_in' },
  /** Webhook status → outcome. TODO(verify) the real status strings. */
  paidStatuses: ['SUCCESS', 'PAID', 'ACCEPTED', 'COMPLETED'],
  failedStatuses: ['FAILED', 'REJECTED', 'CANCELLED', 'ERROR'],
} as const

const PROD = 'https://api.appypay.co.ao'
const SANDBOX = 'https://api.sandbox.appypay.co.ao' // TODO(verify) sandbox host

export interface AppyPayOptions {
  /** OAuth2 client id (from your AppyPay merchant onboarding). */
  clientId: string
  /** OAuth2 client secret. */
  clientSecret: string
  /**
   * OAuth2 token endpoint (full URL). AppyPay issues tokens from an identity
   * host, so this is required rather than guessed. TODO(verify) the exact URL.
   */
  tokenUrl: string
  /** Optional OAuth2 scope/resource, if your token endpoint needs one. */
  scope?: string
  /** API base URL. Defaults to prod, or the sandbox host when `sandbox: true`. */
  baseUrl?: string
  sandbox?: boolean
  /** Method to use when the caller doesn't force one via metadata. Default 'reference'. */
  defaultMethod?: AppyPayMethod
  /**
   * Shared secret to verify webhook signatures (HMAC-SHA256 of the raw body,
   * hex). Omit to skip verification. TODO(verify) AppyPay's real callback auth
   * scheme (header name + whether it's HMAC, Basic, or a bearer token).
   */
  webhookSecret?: string
  /** Header carrying the webhook signature. Default `x-signature`. TODO(verify). */
  webhookSignatureHeader?: string
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
}

export class AppyPayRequestError extends Error {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(`AppyPay request failed (${httpStatus}): ${message}`)
    this.name = 'AppyPayRequestError'
  }
}

export class AppyPayGateway implements PaymentGateway {
  readonly name = 'appypay'
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly tokenUrl: string
  private readonly scope: string | undefined
  private readonly baseUrl: string
  private readonly defaultMethod: AppyPayMethod
  private readonly webhookSecret: string | undefined
  private readonly signatureHeader: string
  private readonly fetchImpl: FetchLike
  private token: { value: string; expiresAt: number } | undefined

  constructor(options: AppyPayOptions) {
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.tokenUrl = options.tokenUrl
    this.scope = options.scope
    this.baseUrl = options.baseUrl ?? (options.sandbox ? SANDBOX : PROD)
    this.defaultMethod = options.defaultMethod ?? 'reference'
    this.webhookSecret = options.webhookSecret
    this.signatureHeader = options.webhookSignatureHeader ?? 'x-signature'
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!f) throw new Error('AppyPayGateway: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  /** Fetch (and cache) an OAuth2 client-credentials bearer token. */
  private async accessToken(): Promise<string> {
    // 30s safety window so we never send an about-to-expire token.
    if (this.token && this.token.expiresAt - 30_000 > Date.now()) return this.token.value

    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      ...(this.scope ? { scope: this.scope } : {}),
    })
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    })
    const text = await res.text()
    if (!res.ok) throw new AppyPayRequestError(res.status, text)
    const data = JSON.parse(text) as Record<string, unknown>
    const value = data[WIRE.token.access]
    if (typeof value !== 'string') {
      throw new AppyPayRequestError(502, `no ${WIRE.token.access} in token response`)
    }
    const expiresIn = Number(data[WIRE.token.expiresIn] ?? 3600)
    this.token = { value, expiresAt: Date.now() + expiresIn * 1000 }
    return value
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await this.accessToken()
    const res = await this.fetchImpl(this.baseUrl + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new AppyPayRequestError(res.status, text)
    return text ? (JSON.parse(text) as Record<string, unknown>) : {}
  }

  async createPayment(request: PaymentRequest): Promise<PaymentInstruction> {
    // Caller can force a method via metadata.appypay_method; else the default.
    const method = (request.metadata?.appypay_method as AppyPayMethod) ?? this.defaultMethod
    if (!(method in WIRE.method)) {
      throw new AppyPayRequestError(400, `unknown AppyPay method: ${method}`)
    }
    if (method === 'express' && !request.customer?.phone) {
      throw new AppyPayRequestError(400, 'Multicaixa Express (express) requires customer.phone')
    }
    assertMinorUnits(request.amount)

    const currency = request.currency ?? 'AOA'
    // TODO(verify): confirm the charge request field names + structure against
    // the AppyPay API docs, and whether `amount` is major-unit (as assumed here)
    // or minor units. `request.amount` is minor units; converted to major here.
    const charge: Record<string, unknown> = {
      merchantTransactionId: request.reference ?? `bsl-${request.billableId}-${Date.now()}`,
      amount: Number(toMajor(request.amount, currency).toFixed(2)),
      currency,
      paymentMethod: WIRE.method[method],
      ...(request.description ? { description: request.description } : {}),
      ...(request.customer?.phone ? { paymentInfo: { phoneNumber: request.customer.phone } } : {}),
      ...(request.metadata ? { metadata: { billable_id: request.billableId, ...request.metadata } } : { metadata: { billable_id: request.billableId } }),
    }

    const data = await this.post(WIRE.chargesPath, charge)
    return this.toInstruction(method, request, data)
  }

  /** Map an AppyPay charge response to a PaymentInstruction. TODO(verify) fields. */
  private toInstruction(
    method: AppyPayMethod,
    request: PaymentRequest,
    data: Record<string, unknown>,
  ): PaymentInstruction {
    const id = String(data.id ?? data.transactionId ?? data.merchantTransactionId ?? request.reference ?? '')
    const base: PaymentInstruction = { id, status: 'pending', raw: data }

    if (method === 'express') {
      const phone = request.customer?.phone
      return { ...base, ...(phone ? { push: { phone } } : {}) }
    }
    if (method === 'reference') {
      return {
        ...base,
        reference: {
          entity: String(data.entity ?? data.entityId ?? ''),
          reference: String(data.reference ?? data.referenceId ?? id),
          amount: request.amount,
        },
      }
    }
    // card / hosted redirect
    const url = data.redirectUrl ?? data.paymentUrl ?? data.url
    return { ...base, ...(url ? { url: String(url) } : {}) }
  }

  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null {
    // Fail closed: without a configured secret we cannot authenticate the
    // callback, and an unsigned webhook lets anyone forge a `payment.succeeded`
    // to settle an invoice. Refuse rather than silently trust it.
    // TODO(verify): AppyPay's real callback auth (header name + signing scheme).
    if (!this.webhookSecret) throw new WebhookSecretMissingError('AppyPayGateway')
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex')
    const a = Buffer.from(signature ?? '', 'utf8')
    const b = Buffer.from(expected, 'utf8')
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookInvalidError()

    // TODO(verify): the real webhook payload shape + status field.
    const payload = JSON.parse(rawBody) as {
      id?: string | number
      merchantTransactionId?: string | number
      transactionId?: string | number
      status?: string
      amount?: string | number
      metadata?: Record<string, string>
    }

    const status = String(payload.status ?? '').toUpperCase()
    const isPaid = (WIRE.paidStatuses as readonly string[]).includes(status)
    const isFailed = (WIRE.failedStatuses as readonly string[]).includes(status)
    if (!isPaid && !isFailed) return null // not a terminal payment event we act on

    const paymentId = String(payload.merchantTransactionId ?? payload.id ?? payload.transactionId ?? '')
    return {
      id: String(payload.id ?? payload.transactionId ?? paymentId),
      type: isPaid ? 'payment.succeeded' : 'payment.failed',
      paymentId,
      // TODO(verify): AppyPay's webhook amount unit. Assumed major → minor here.
      amount: toMinor(Number(payload.amount ?? 0), 'AOA'),
      ...(payload.metadata?.billable_id ? { billableId: payload.metadata.billable_id } : {}),
      ...(payload.metadata?.reference ? { reference: payload.metadata.reference } : {}),
      raw: payload,
    }
  }
}

export { WIRE as APPYPAY_WIRE }
