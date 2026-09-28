import { createHmac, timingSafeEqual } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { BillingPeriod } from '../plans.js'
import {
  attestedPlan,
  CheckoutRequiredError,
  requireWebhookSecret,
  WebhookInvalidError,
  type BillingGateway,
  type CheckoutInput,
  type CreateSubscriptionInput,
  type PortalInput,
  type SwapInput,
  type WebhookEvent,
} from '../gateway.js'

export class LemonSqueezyRequestError extends BasaltError {
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super('BILLING_GATEWAY_ERROR', `Lemon Squeezy request failed (${httpStatus}): ${message}`)
  }
}

/** Loosely-typed Lemon Squeezy webhook envelope — we only touch a few fields. */
interface LemonEvent {
  meta?: { event_name?: string; custom_data?: Record<string, string> | null }
  data?: {
    id?: string
    type?: string
    attributes?: {
      subscription_id?: string | number
      created_at?: string
      updated_at?: string
      [key: string]: unknown
    }
  }
}

/** Lemon Squeezy `meta.event_name` → Basalt domain webhook type. Others ignored. */
const EVENT_MAP: Record<string, WebhookEvent['type']> = {
  subscription_cancelled: 'subscription.canceled',
  subscription_expired: 'subscription.canceled',
  subscription_payment_success: 'payment.succeeded',
  subscription_payment_failed: 'payment.failed',
}

export interface LemonSqueezyGatewayOptions {
  /** Lemon Squeezy API key (Bearer). */
  apiKey: string
  /** Webhook signing secret used to verify `X-Signature`. */
  webhookSecret: string
  /** Lemon Squeezy Store ID (needed to create checkouts). */
  storeId: string
  /** Resolves the Lemon Squeezy Variant ID for a plan + billing period. */
  variantId: (plan: string, period: BillingPeriod) => string
  /** Resolves the Lemon Squeezy Customer ID for a billable — required for the portal. */
  customerId?: (billableId: string) => string | Promise<string>
  /**
   * Extracts the billable id from a verified event. Default: reads
   * `meta.custom_data.billableId` — which the checkout call sets.
   */
  resolveBillableId?: (event: unknown) => string | undefined
  /**
   * Optional replay window in seconds. Lemon Squeezy's `X-Signature` covers the
   * body only — there is no signed timestamp — so a captured delivery stays
   * valid forever and only the webhook dedupe store stops a replay. When set,
   * an event whose `data.attributes.updated_at` (or `created_at`) is older than
   * this, or missing, is rejected with `WebhookInvalidError`. Leave it unset if
   * you re-send old events from the Lemon Squeezy dashboard. Default: off.
   */
  maxEventAgeSeconds?: number
  /** Clock in ms (tests), for `maxEventAgeSeconds`. Default: Date.now. */
  now?: () => number
  /** Injected fetch (tests). Default: global fetch. */
  fetch?: typeof fetch
  /** API base, for tests/mocks. Default: https://api.lemonsqueezy.com/v1 */
  apiBase?: string
}

const JSON_API = 'application/vnd.api+json'

/**
 * Lemon Squeezy billing gateway targeting the REST API directly (JSON:API) — no
 * SDK. Lemon Squeezy is a merchant-of-record and checkout-first, so
 * `createCheckoutSession` creates a **checkout**; the durable subscription id
 * arrives on a `subscription_*` webhook via `gatewayRef`. `createSubscription`
 * throws {@link CheckoutRequiredError} (use `Subscriptions.checkout()`). Webhook
 * signatures use the `X-Signature` scheme (HMAC-SHA256 hex over the raw body).
 */
export class LemonSqueezyBillingGateway implements BillingGateway {
  readonly name = 'lemonsqueezy'
  readonly signatureHeader = 'x-signature'
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly apiBase: string
  private readonly resolveBillableId: (event: unknown) => string | undefined

  constructor(private readonly options: LemonSqueezyGatewayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.apiBase = options.apiBase ?? 'https://api.lemonsqueezy.com/v1'
    this.resolveBillableId =
      options.resolveBillableId ??
      ((event) => (event as LemonEvent | undefined)?.meta?.custom_data?.['billableId'])
  }

  /**
   * Always throws {@link CheckoutRequiredError}: a checkout id is not a
   * subscription (returning it as the ref activated the plan unpaid and left a
   * ref `cancel`/`swap` could not address).
   */
  async createSubscription(_input: CreateSubscriptionInput): Promise<{ gatewayRef: string }> {
    throw new CheckoutRequiredError('Lemon Squeezy')
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ url: string; id: string }> {
    const checkout = await this.checkout(input.billableId, input.plan, input.period, input.successUrl)
    return { url: String(checkout.attributes?.url), id: String(checkout.id) }
  }

  private async checkout(billableId: string, plan: string, period: BillingPeriod, redirectUrl?: string) {
    const created = (await this.request('POST', '/checkouts', {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { custom: { billableId, plan, period } },
          ...(redirectUrl ? { product_options: { redirect_url: redirectUrl } } : {}),
        },
        relationships: {
          store: { data: { type: 'stores', id: this.options.storeId } },
          variant: { data: { type: 'variants', id: this.options.variantId(plan, period) } },
        },
      },
    })) as { id?: string; attributes?: { url?: string } }
    return created
  }

  async cancelSubscription(gatewayRef: string, _options: { atPeriodEnd: boolean }): Promise<void> {
    // Lemon Squeezy DELETE cancels the subscription; it stays active until the
    // end of the current billing period (there is no true immediate cancel).
    await this.request('DELETE', `/subscriptions/${gatewayRef}`)
  }

  async createPortalSession(input: PortalInput): Promise<{ url: string }> {
    if (!this.options.customerId) {
      throw new LemonSqueezyRequestError(500, 'customerId resolver is required for the customer portal')
    }
    const customer = await this.options.customerId(input.billableId)
    const found = (await this.request('GET', `/customers/${customer}`)) as {
      attributes?: { urls?: { customer_portal?: string } }
    }
    return { url: String(found.attributes?.urls?.customer_portal) }
  }

  async resumeSubscription(gatewayRef: string): Promise<void> {
    // A cancelled subscription in its grace period is resumed by un-cancelling it.
    await this.request('PATCH', `/subscriptions/${gatewayRef}`, {
      data: { type: 'subscriptions', id: gatewayRef, attributes: { cancelled: false } },
    })
  }

  async swapSubscription(gatewayRef: string, input: SwapInput): Promise<void> {
    const behavior = input.prorationBehavior ?? 'create_prorations'
    await this.request('PATCH', `/subscriptions/${gatewayRef}`, {
      data: {
        type: 'subscriptions',
        id: gatewayRef,
        attributes: {
          variant_id: this.options.variantId(input.plan, input.period),
          disable_prorations: behavior === 'none',
          ...(behavior === 'always_invoice' ? { invoice_immediately: true } : {}),
        },
      },
    })
  }

  verifyWebhook(rawBody: string, signature: string | undefined): WebhookEvent | null {
    // Fail closed before anything else: an empty/missing secret would make the
    // HMAC forgeable by anyone.
    const secret = requireWebhookSecret('LemonSqueezyBillingGateway', this.options.webhookSecret)
    if (!signature) throw new WebhookInvalidError()

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookInvalidError()

    let event: LemonEvent
    try {
      event = JSON.parse(rawBody) as LemonEvent
    } catch {
      throw new WebhookInvalidError()
    }

    if (this.options.maxEventAgeSeconds !== undefined) {
      const stamp = event.data?.attributes?.updated_at ?? event.data?.attributes?.created_at
      const at = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
      if (!Number.isFinite(at) || this.now() - at > this.options.maxEventAgeSeconds * 1000) {
        throw new WebhookInvalidError()
      }
    }

    const name = event.meta?.event_name
    const type = name && Object.hasOwn(EVENT_MAP, name) ? EVENT_MAP[name] : undefined
    if (!type) return null
    const billableId = this.resolveBillableId(event)
    if (!billableId) return null
    // Payment events carry the subscription id in attributes.subscription_id;
    // subscription events carry it in data.id.
    const rawRef = event.data?.attributes?.subscription_id ?? event.data?.id
    const gatewayRef = rawRef !== undefined ? String(rawRef) : undefined
    // Lemon Squeezy webhooks have no event id of their own. The key must be
    // stable across re-deliveries of ONE event yet distinct between events:
    // `data.id` is the subscription-invoice id on payment events (new on every
    // renewal) and the subscription id on subscription events, and `updated_at`
    // separates repeated events on the same object (a second cancel after a
    // resume, another failed retry). Keying on the subscription alone dropped
    // every renewal after the first as a "duplicate".
    const objectId = event.data?.id !== undefined ? String(event.data.id) : (gatewayRef ?? billableId)
    const version = event.data?.attributes?.updated_at ?? event.data?.attributes?.created_at ?? ''
    const id = `${name}:${event.data?.type ?? ''}:${objectId}:${version}`
    // The plan/period we stamped into the checkout's custom data (signed
    // payload). Lemon custom data is immutable after checkout, so a later
    // variant change (swap or the customer portal) leaves it stale: it is
    // only bound to what was charged on the checkout's INITIAL invoice.
    const { plan, period } =
      event.data?.attributes?.['billing_reason'] === 'initial'
        ? attestedPlan(event.meta?.custom_data)
        : {}
    return {
      id,
      type,
      billableId,
      ...(gatewayRef ? { gatewayRef } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(period !== undefined ? { period } : {}),
    }
  }

  private async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        accept: JSON_API,
        ...(body !== undefined ? { 'content-type': JSON_API } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    const json = text ? (JSON.parse(text) as { data?: unknown; errors?: { detail?: string }[] }) : {}
    if (!response.ok) {
      throw new LemonSqueezyRequestError(response.status, json.errors?.[0]?.detail ?? text ?? 'unknown error')
    }
    return (json as { data?: unknown }).data ?? json
  }
}
