import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { resolveAndValidate, WebhookUrlBlockedError, type SsrfGuardOptions, type ValidatedAddress } from './ssrf.js'
import { PINNED_ADDRESS, pinnedFetch, pinnedRequest } from './pinned-fetch.js'
import type { WebhookEndpoint } from './store.js'

export { PINNED_ADDRESS, pinnedFetch }

/**
 * Outward error for a URL blocked on a DNS-derived verdict. Deliberately one
 * message for "does not resolve" and "resolves to a private address", with no
 * address: anything more would let whoever configures endpoints map internal DNS.
 */
const DNS_BLOCKED_ERROR = 'Refusing to deliver webhook: host does not resolve to an allowed public address.'

/**
 * Derives a deterministic delivery id (UUID-shaped) from an idempotency key and
 * the endpoint id, so every re-delivery of the same logical event to the same
 * endpoint — including outbox retries across flushes and restarts — carries the
 * same `id` the receiver dedupes on.
 */
export function deriveDeliveryId(idempotencyKey: string, endpointId: string): string {
  const b = createHash('sha256').update(`basalt.webhooks.delivery\0${idempotencyKey}\0${endpointId}`).digest()
  b[6] = (b[6]! & 0x0f) | 0x80 // version 8 (custom)
  b[8] = (b[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const h = b.subarray(0, 16).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

let unpinnedFetchWarned = false

/**
 * Minimum length of a webhook signing secret. Shorter (or empty/unset) secrets
 * are refused on both ends: the deliverer won't sign with one and
 * {@link verifySignature} won't accept one, so a receiver whose secret env var
 * is unset can never be satisfied by an HMAC computed with an empty key.
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 16

/** Generates a fresh per-endpoint signing secret (`whsec_` + 32 random bytes). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

/**
 * Signs a payload the Stripe way: `t=<unix>,v1=<hmac-sha256(t.body)>`. The
 * receiver recomputes the HMAC over `timestamp.body` and compares in constant
 * time, rejecting stale timestamps to stop replays.
 */
export function signPayload(body: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')
  return `t=${timestampSeconds},v1=${signature}`
}

/**
 * Verifies a signature header (for tests and receiver SDKs). The header may
 * carry several `v1=` entries — a sender rotating its secret signs with both the
 * new and the old one — and is valid when ANY of them matches, as Stripe
 * receivers do. Unknown schemes are ignored; a malformed header (no/duplicate
 * `t`, no `v1`) is `false`, and so is an empty, unset or shorter-than-
 * {@link MIN_WEBHOOK_SECRET_LENGTH} secret.
 *
 * Throws a `RangeError` when `toleranceSeconds` is not a finite number ≥ 0 or
 * `nowSeconds` is not finite (e.g. `Number(process.env.UNSET)` → `NaN`): such a
 * value would otherwise make every timestamp "fresh" and silently disable
 * replay protection. That is a configuration bug, never a verdict on a request.
 */
export function verifySignature(header: string, body: string, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (typeof toleranceSeconds !== 'number' || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new RangeError(`verifySignature(): toleranceSeconds must be a finite number >= 0 (got ${String(toleranceSeconds)})`)
  }
  if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds)) {
    throw new RangeError(`verifySignature(): nowSeconds must be a finite number (got ${String(nowSeconds)})`)
  }
  if (typeof secret !== 'string' || secret.length < MIN_WEBHOOK_SECRET_LENGTH) return false
  if (typeof header !== 'string') return false
  let rawTimestamp: string | undefined
  const provided: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') {
      if (rawTimestamp !== undefined) return false
      rawTimestamp = value
    } else if (key === 'v1' && value) {
      provided.push(value)
    }
  }
  const timestamp = Number(rawTimestamp)
  if (!rawTimestamp || !Number.isFinite(timestamp) || provided.length === 0) return false
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${rawTimestamp}.${body}`).digest('hex'))
  // Check every candidate (no early exit) so timing doesn't reveal which one matched.
  let valid = false
  for (const candidate of provided) {
    const a = Buffer.from(candidate)
    if (a.length === expected.length && timingSafeEqual(a, expected)) valid = true
  }
  return valid
}

export interface DeliveryResult {
  endpointId: string
  ok: boolean
  status?: number
  attempts: number
  error?: string
  /**
   * On a failure: `true` when retrying later may succeed (network error,
   * timeout, `5xx`, `408`/`429`, unexpected error), `false` when it is permanent
   * (refused signing secret, SSRF-blocked URL, redirect, other `4xx`). The
   * webhook outbox only re-queues an entry for retryable failures.
   */
  retryable?: boolean
}

/** Per-call options for {@link WebhookDeliverer.deliver}. */
export interface DeliverOptions {
  /**
   * Delivery id put in the signed body (`id`) and `x-basalt-delivery`. Pass a
   * stable one (see {@link deriveDeliveryId}) when the same logical delivery may
   * be re-sent later, so the receiver can dedupe. Default: a fresh UUID (stable
   * across this call's own retries only).
   */
  deliveryId?: string
}

export interface WebhookDelivererOptions {
  /**
   * Default signing secret (an endpoint's own `secret` overrides it). At least
   * {@link MIN_WEBHOOK_SECRET_LENGTH} characters. It is only used for
   * tenant-agnostic endpoints: a tenant-bound endpoint must carry its own secret
   * (see `allowSharedSecret`), since a secret shared by every tenant would let
   * one tenant forge webhooks another tenant's receiver accepts.
   */
  secret?: string
  /**
   * Opt-out: sign tenant-bound endpoints that have no own secret with the shared
   * default `secret`. Off by default — such deliveries are refused.
   */
  allowSharedSecret?: boolean
  /**
   * Opt-out: send deliveries unsigned when neither the endpoint nor the
   * deliverer has a secret. Off by default — unsigned deliveries are refused,
   * since receivers could not tell them from forgeries.
   */
  allowUnsigned?: boolean
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number
  /** Base backoff in ms, doubled per attempt. Default 500. */
  backoffMs?: number
  /** Per-attempt timeout in ms. Default 10s. */
  timeoutMs?: number
  /**
   * (Advanced) custom HTTP client. The default is NOT global `fetch` but a
   * built-in transport that pins the socket to the SSRF-validated IP (defeats
   * DNS rebinding). A custom `fetchImpl` receives that IP on its init object
   * under {@link PINNED_ADDRESS} but plain `fetch` ignores it and re-resolves
   * the hostname, re-opening the rebind window. To keep pinning, delegate to
   * {@link pinnedFetch} (or pin via your own dispatcher) and set
   * `fetchImplPinsAddress: true`. Otherwise the deliverer warns once
   * (`BASALT_WEBHOOKS_UNPINNED_FETCH`) and re-validates the host before every
   * retry — which narrows, but cannot close, the window.
   */
  fetchImpl?: typeof fetch
  /**
   * Declares that the custom `fetchImpl` honours `init[PINNED_ADDRESS]` (e.g. it
   * delegates to {@link pinnedFetch}). Silences the unpinned-fetch warning and
   * skips the per-retry re-validation.
   */
  fetchImplPinsAddress?: boolean
  sleep?: (ms: number) => Promise<void>
  /** Clock in seconds, for deterministic tests. */
  now?: () => number
  /**
   * SSRF guard for the delivery URL. By default every delivery is refused if the
   * URL scheme isn't http(s) or the host is/resolves to a private, loopback,
   * link-local, CGNAT, ULA or reserved address. Set `ssrf.allowPrivateHosts:
   * true` only for a trusted self-hosted setup that delivers to internal hosts.
   */
  ssrf?: SsrfGuardOptions | false
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** POSTs signed JSON to an endpoint, retrying transient failures with backoff. */
export class WebhookDeliverer {
  private readonly maxRetries: number
  private readonly backoffMs: number
  private readonly timeoutMs: number
  /** Injected HTTP client; when absent the built-in pinned transport is used. */
  private readonly fetchImpl: typeof fetch | undefined
  /** A custom fetchImpl that is not known to honour the pin (SSRF guard active). */
  private readonly unpinnedFetch: boolean
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: WebhookDelivererOptions = {}) {
    if (options.secret !== undefined && (typeof options.secret !== 'string' || options.secret.length < MIN_WEBHOOK_SECRET_LENGTH)) {
      throw new Error(
        `Webhook signing secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters (generate one with generateWebhookSecret()).`,
      )
    }
    this.maxRetries = options.maxRetries ?? 3
    this.backoffMs = options.backoffMs ?? 500
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl
    this.unpinnedFetch =
      options.fetchImpl !== undefined &&
      options.fetchImpl !== (pinnedFetch as unknown) &&
      !options.fetchImplPinsAddress &&
      options.ssrf !== false &&
      !options.ssrf?.allowPrivateHosts
    if (this.unpinnedFetch && !unpinnedFetchWarned) {
      unpinnedFetchWarned = true
      process.emitWarning(
        'WebhookDeliverer: a custom fetchImpl does not pin connections to the SSRF-validated IP, so DNS rebinding ' +
          'can reach internal hosts. Delegate to pinnedFetch() (and set fetchImplPinsAddress: true) to keep pinning.',
        { code: 'BASALT_WEBHOOKS_UNPINNED_FETCH' },
      )
    }
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /**
   * URL schemes this deliverer will send to (`ssrf.allowedSchemes`, default
   * `https:` and `http:`). `WebhookManager.register()` refuses other schemes.
   */
  get allowedSchemes(): readonly string[] {
    return (this.options.ssrf === false ? undefined : this.options.ssrf?.allowedSchemes) ?? ['https:', 'http:']
  }

  /** True when a default (plugin-wide) signing secret is configured. */
  get hasDefaultSecret(): boolean {
    return this.options.secret !== undefined
  }

  /** Resolves the signing secret for `endpoint`, or the reason delivery is refused. */
  private signingSecret(endpoint: WebhookEndpoint): { secret?: string; refused?: string } {
    // `!= null`: SQL-backed stores may hand back `secret: null` / `tenantId: null`
    // for "absent"; both must mean the same as a missing field.
    if (endpoint.secret != null) {
      if (typeof endpoint.secret !== 'string' || endpoint.secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
        return { refused: `endpoint signing secret is too short (min ${MIN_WEBHOOK_SECRET_LENGTH} characters)` }
      }
      return { secret: endpoint.secret }
    }
    if (this.options.secret !== undefined) {
      if (endpoint.tenantId != null && !this.options.allowSharedSecret) {
        return { refused: 'tenant endpoint has no own secret; refusing to sign with the shared secret' }
      }
      return { secret: this.options.secret }
    }
    if (this.options.allowUnsigned) return {}
    return { refused: 'no signing secret; refusing unsigned delivery' }
  }

  /**
   * Sends one request. With no injected `fetchImpl`, uses the built-in transport
   * that pins the socket to `pinned` (rebind-proof). An injected `fetchImpl`
   * receives the pin on the init object under {@link PINNED_ADDRESS} so callers
   * that pin via a dispatcher (or delegate to {@link pinnedFetch}) keep it.
   */
  private send(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal },
    pinned: ValidatedAddress | null,
  ): Promise<{ ok: boolean; status: number; type?: string }> {
    if (this.fetchImpl) {
      const initWithPin = { ...init, [PINNED_ADDRESS]: pinned } as RequestInit
      return this.fetchImpl(url, initWithPin)
    }
    return pinnedRequest(new URL(url), init, pinned)
  }

  async deliver(endpoint: WebhookEndpoint, event: string, data: unknown, options: DeliverOptions = {}): Promise<DeliveryResult> {
    const { secret, refused } = this.signingSecret(endpoint)
    if (refused) return { endpointId: endpoint.id, ok: false, attempts: 0, error: refused, retryable: false }
    const timestamp = this.now()
    // A delivery id (stable across this delivery's retries — and across later
    // re-deliveries when the caller passes a derived one) and the endpoint id are
    // part of the signed body, so a receiver can dedupe replays and reject a
    // payload signed for a different endpoint.
    const deliveryId = options.deliveryId ?? randomUUID()
    const body = JSON.stringify({
      id: deliveryId,
      event,
      endpointId: endpoint.id,
      data,
      sentAt: new Date(timestamp * 1000).toISOString(),
    })

    // SSRF guard (unless explicitly disabled): resolve+validate the URL ONCE up
    // front and remember the validated address. The connection is later pinned to
    // it so a DNS rebind between check and connect (TOCTOU) can't swap in an
    // internal IP. A blocked URL is a permanent config error → fail without retry.
    // The outward error is generic: the detailed reason (and any resolved
    // internal address) stays on the WebhookUrlBlockedError, never in the result.
    let pinned: ValidatedAddress | null = null
    const validate = async (): Promise<DeliveryResult | undefined> => {
      if (this.options.ssrf === false) return undefined
      try {
        pinned = (await resolveAndValidate(endpoint.url, this.options.ssrf ?? {})).pinned
        return undefined
      } catch (error) {
        if (error instanceof WebhookUrlBlockedError) {
          const message = error.dnsDerived ? DNS_BLOCKED_ERROR : error.message
          return { endpointId: endpoint.id, ok: false, attempts, error: message, retryable: false }
        }
        throw error
      }
    }

    let attempts = 0
    let lastStatus: number | undefined
    let lastError: string | undefined
    const blocked = await validate()
    if (blocked) return blocked

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // An unpinned custom fetchImpl re-resolves the host itself: re-validate
      // before each retry so a rebind during backoff is at least caught here.
      if (attempt > 0 && this.unpinnedFetch) {
        const reblocked = await validate()
        if (reblocked) return reblocked
      }
      attempts += 1
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-basalt-event': event,
          'x-basalt-delivery': deliveryId,
        }
        // Signed with the time of THIS attempt: a retry after a long backoff must
        // still fall inside the receiver's replay tolerance.
        if (secret) headers['x-basalt-signature'] = signPayload(body, secret, this.now())

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
          // `redirect: 'manual'` so a 3xx can't bounce the request to an internal
          // address that bypassed the SSRF check on the original URL. The socket
          // is pinned to the validated `pinned` address (rebind-proof).
          const response = await this.send(endpoint.url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal }, pinned)
          lastStatus = response.status
          // Only the status matters: release an injected fetch's body instead of
          // leaving it (and its socket) open until garbage collection.
          try {
            void (response as { body?: { cancel?: () => Promise<void> } | null }).body?.cancel?.()?.catch(() => {})
          } catch {
            // a locked/consumed body is already being handled by its owner
          }
          if (response.ok) return { endpointId: endpoint.id, ok: true, status: response.status, attempts }
          // A redirect is refused, not followed (opaqueredirect ⇒ status 0).
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            return { endpointId: endpoint.id, ok: false, status: response.status, attempts, error: 'redirect refused', retryable: false }
          }
          // 4xx is a client error — do not retry inline. 408/429 are worth a
          // later retry (outbox), every other 4xx is permanent.
          if (response.status < 500) {
            const retryable = response.status === 408 || response.status === 429
            return { endpointId: endpoint.id, ok: false, status: response.status, attempts, error: `HTTP ${response.status}`, retryable }
          }
        } finally {
          clearTimeout(timer)
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      if (attempt < this.maxRetries) await this.sleep(this.backoffMs * 2 ** attempt)
    }

    return {
      endpointId: endpoint.id,
      ok: false,
      attempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      ...(lastError !== undefined ? { error: lastError } : {}),
      retryable: true,
    }
  }
}
