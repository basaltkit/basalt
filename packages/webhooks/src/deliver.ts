import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  assertAllowedPortsOption,
  isPortAllowed,
  resolveAndValidate,
  WebhookUrlBlockedError,
  type SsrfGuardOptions,
  type ValidatedAddress,
} from './ssrf.js'
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

/** Default prefix of the delivery headers (`x-basalt-event`, `x-basalt-delivery`, `x-basalt-signature`). */
export const DEFAULT_WEBHOOK_HEADER_PREFIX = 'x-basalt'

const HEADER_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Names of the three headers a delivery carries, for a given prefix. */
export interface WebhookHeaderNames {
  /** `<prefix>-event` — the event name. */
  event: string
  /** `<prefix>-delivery` — the delivery id (also `id` in the signed body). */
  delivery: string
  /** `<prefix>-signature` — `t=<unix>,v1=<hmac>`. */
  signature: string
}

/**
 * The header names a deliverer configured with `headerPrefix` sends — and the
 * ones its receiver reads. Use the same prefix on both ends:
 *
 * ```ts
 * const names = webhookHeaderNames('x-acme')
 * verifySignature(request.headers[names.signature] as string, body.bytes, secret)
 * ```
 *
 * The prefix is lower-case, starts with a letter and has at most 32 characters
 * of `[a-z0-9-]`; anything else throws a `TypeError` (header names are
 * case-insensitive on the wire, and a lower-case prefix matches the lower-cased
 * header maps every adapter exposes).
 */
export function webhookHeaderNames(prefix: string = DEFAULT_WEBHOOK_HEADER_PREFIX): WebhookHeaderNames {
  if (typeof prefix !== 'string' || !HEADER_PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(
      `webhooks: headerPrefix must match ${String(HEADER_PREFIX_PATTERN)} (lower-case, starts with a letter, max 32 chars); got ${JSON.stringify(prefix)}`,
    )
  }
  return { event: `${prefix}-event`, delivery: `${prefix}-delivery`, signature: `${prefix}-signature` }
}

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
 *
 * Pass several secrets (current first) to emit one `v1=` entry per secret —
 * what the deliverer does during a secret rotation's grace window, so a
 * receiver still verifying with the previous secret keeps accepting.
 */
export function signPayload(body: string | Uint8Array, secret: string | readonly string[], timestampSeconds: number): string {
  const secrets = typeof secret === 'string' ? [secret] : secret
  if (secrets.length === 0) throw new TypeError('signPayload(): at least one secret is required')
  const signatures = secrets.map((key) => `v1=${hmacHex(key, String(timestampSeconds), body)}`)
  return `t=${timestampSeconds},${signatures.join(',')}`
}

/**
 * HMAC-SHA256 over `${timestamp}.` followed by the body bytes. A string body is
 * UTF-8 encoded, so a string and the `Buffer`/`Uint8Array` of its UTF-8 bytes
 * produce the same signature — and a raw request body (`rawBody()` route) can be
 * verified byte-for-byte without a lossy decode.
 */
function hmacHex(secret: string, timestamp: string, body: string | Uint8Array): string {
  const hmac = createHmac('sha256', secret)
  hmac.update(`${timestamp}.`)
  if (typeof body === 'string') hmac.update(body, 'utf8')
  else if (body instanceof Uint8Array) hmac.update(body)
  else throw new TypeError('webhook signature body must be a string or a Uint8Array')
  return hmac.digest('hex')
}

/**
 * Verifies a signature header (for tests and receiver SDKs). `body` is the raw
 * request body exactly as received — a string, or the bytes (`Buffer` /
 * `Uint8Array`, e.g. from a `rawBody()` route) — never a re-serialised parse of
 * it. The header may
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
export function verifySignature(header: string, body: string | Uint8Array, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
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
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) return false
  const expected = Buffer.from(hmacHex(secret, rawTimestamp, body))
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
  /** HTTP status of the last response received, when one was. */
  status?: number
  attempts: number
  error?: string
  /**
   * Wall-clock time the whole delivery took, in ms — every attempt, DNS
   * resolution and backoff included. Set by the bundled deliverer; absent on
   * results a delivery never started for (e.g. a fan-out refusal).
   */
  durationMs?: number
  /**
   * On a failure: `true` when retrying later may succeed (network error,
   * timeout, `5xx`, `408`/`429`, unexpected error), `false` when it is permanent
   * (refused signing secret, SSRF-blocked URL, redirect, other `4xx`). The
   * webhook outbox only re-queues an entry for retryable failures.
   */
  retryable?: boolean
}

/**
 * One delivery attempt, reported through `onAttempt` — enough for an app to
 * keep its own delivery log (the deliverer stores nothing itself, and never
 * reads the response body).
 */
export interface WebhookAttempt {
  deliveryId: string
  endpointId: string
  /** The endpoint's tenant; absent for a tenant-agnostic endpoint. */
  tenantId?: string
  event: string
  /** 1-based attempt number within this delivery. */
  attempt: number
  /** True when the receiver answered `2xx`. */
  ok: boolean
  /** HTTP status received, when a response arrived. */
  status?: number
  /** Duration of this attempt (DNS resolution + request), in ms. */
  durationMs: number
  /** Why the attempt failed (`HTTP 503`, `redirect refused`, a network error, …). */
  error?: string
  /** When the attempt started. */
  at: Date
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
  /**
   * Per-attempt deadline in ms, covering DNS resolution AND the request: a
   * resolver that hangs fails the attempt like a slow receiver does. Default 10s.
   */
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
   * Prefix of the delivery headers: `<prefix>-event`, `<prefix>-delivery` and
   * `<prefix>-signature`. Default {@link DEFAULT_WEBHOOK_HEADER_PREFIX}
   * (`x-basalt`). Lower-case, `[a-z][a-z0-9-]{0,31}`; validated at
   * construction. Receivers read the same names with {@link webhookHeaderNames}.
   */
  headerPrefix?: string
  /**
   * Called after every delivery attempt (including one whose deadline ran out
   * while resolving the host), e.g. to persist a delivery log. Deliveries
   * refused before any attempt (no secret, blocked URL) are reported only in
   * the {@link DeliveryResult}. Not awaited, and must not throw: an exception
   * or rejection is logged and swallowed, never changing the delivery.
   */
  onAttempt?: (attempt: WebhookAttempt) => void | Promise<void>
  /**
   * SSRF guard for the delivery URL. By default every delivery is refused if the
   * URL scheme isn't http(s) or the host is/resolves to a private, loopback,
   * link-local, CGNAT, ULA or reserved address. Set `ssrf.allowPrivateHosts:
   * true` only for a trusted self-hosted setup that delivers to internal hosts.
   */
  ssrf?: SsrfGuardOptions | false
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Outward error for an attempt whose deadline ran out while resolving the host. */
const DNS_TIMEOUT_ERROR = 'host resolution timed out'

/** Rejects with `onAbort()` as soon as `signal` aborts; otherwise settles like `promise`. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort())
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(onAbort())
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** Epoch ms of a stored timestamp (`Date`, ISO string or epoch ms), or NaN. */
function epochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string' || typeof value === 'number') return new Date(value).getTime()
  return Number.NaN
}

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
  private readonly headerNames: WebhookHeaderNames

  constructor(private readonly options: WebhookDelivererOptions = {}) {
    if (options.secret !== undefined && (typeof options.secret !== 'string' || options.secret.length < MIN_WEBHOOK_SECRET_LENGTH)) {
      throw new Error(
        `Webhook signing secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters (generate one with generateWebhookSecret()).`,
      )
    }
    if (options.ssrf !== false) assertAllowedPortsOption(options.ssrf?.allowedPorts)
    this.headerNames = webhookHeaderNames(options.headerPrefix ?? DEFAULT_WEBHOOK_HEADER_PREFIX)
    if (options.onAttempt !== undefined && typeof options.onAttempt !== 'function') {
      throw new TypeError('webhooks: onAttempt must be a function')
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

  /**
   * True when this deliverer would send to `port` (the `ssrf.allowedPorts`
   * policy; any port with `ssrf: false`). `WebhookManager.register()` refuses
   * other ports.
   */
  allowsPort(port: number): boolean {
    if (this.options.ssrf === false) return true
    return isPortAllowed(port, this.options.ssrf?.allowedPorts)
  }

  /** True when a default (plugin-wide) signing secret is configured. */
  get hasDefaultSecret(): boolean {
    return this.options.secret !== undefined
  }

  /**
   * The secrets to sign `endpoint`'s deliveries with (current first, then the
   * previous one while its rotation grace window is open), or the reason
   * delivery is refused. An empty list means "send unsigned" (`allowUnsigned`).
   */
  private signingSecrets(endpoint: WebhookEndpoint): { secrets: string[]; refused?: string } {
    // `!= null`: SQL-backed stores may hand back `secret: null` / `tenantId: null`
    // for "absent"; both must mean the same as a missing field.
    if (endpoint.secret != null) {
      if (typeof endpoint.secret !== 'string' || endpoint.secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
        return { secrets: [], refused: `endpoint signing secret is too short (min ${MIN_WEBHOOK_SECRET_LENGTH} characters)` }
      }
      const secrets = [endpoint.secret]
      // Rotation grace: keep signing with the previous secret until it expires.
      // A previous secret with no (or an unparseable) expiry is ignored — the
      // window must be bounded — and so is one too short to be a real key.
      const previous = endpoint.previousSecret
      if (
        typeof previous === 'string' &&
        previous.length >= MIN_WEBHOOK_SECRET_LENGTH &&
        previous !== endpoint.secret &&
        epochMs(endpoint.previousSecretExpiresAt) > this.now() * 1000
      ) {
        secrets.push(previous)
      }
      return { secrets }
    }
    if (this.options.secret !== undefined) {
      if (endpoint.tenantId != null && !this.options.allowSharedSecret) {
        return { secrets: [], refused: 'tenant endpoint has no own secret; refusing to sign with the shared secret' }
      }
      return { secrets: [this.options.secret] }
    }
    if (this.options.allowUnsigned) return { secrets: [] }
    return { secrets: [], refused: 'no signing secret; refusing unsigned delivery' }
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

  /** Reports one attempt to `onAttempt`; a throwing/rejecting hook never affects the delivery. */
  private reportAttempt(attempt: WebhookAttempt): void {
    const hook = this.options.onAttempt
    if (!hook) return
    const report = (error: unknown): void => console.error('[basalt:webhooks] onAttempt hook failed:', error)
    try {
      const pending = hook(attempt)
      if (pending && typeof (pending as Promise<void>).then === 'function') (pending as Promise<void>).then(undefined, report)
    } catch (error) {
      report(error)
    }
  }

  async deliver(endpoint: WebhookEndpoint, event: string, data: unknown, options: DeliverOptions = {}): Promise<DeliveryResult> {
    const startedAt = performance.now()
    const elapsed = (since: number): number => Math.max(0, Math.round(performance.now() - since))
    const done = (result: DeliveryResult): DeliveryResult => ({ ...result, durationMs: elapsed(startedAt) })
    const { secrets, refused } = this.signingSecrets(endpoint)
    if (refused) return done({ endpointId: endpoint.id, ok: false, attempts: 0, error: refused, retryable: false })
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

    const tenantId = typeof endpoint.tenantId === 'string' && endpoint.tenantId !== '' ? endpoint.tenantId : undefined
    let attempts = 0
    let attemptStart = startedAt
    let attemptAt = new Date()
    const attempted = (outcome: { ok: boolean; status?: number; error?: string }): void =>
      this.reportAttempt({
        deliveryId,
        endpointId: endpoint.id,
        ...(tenantId !== undefined ? { tenantId } : {}),
        event,
        attempt: attempts,
        ok: outcome.ok,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        durationMs: elapsed(attemptStart),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
        at: attemptAt,
      })
    let lastStatus: number | undefined
    let lastError: string | undefined
    // SSRF guard (unless explicitly disabled): resolve+validate the URL and
    // remember the validated address. The connection is later pinned to it so a
    // DNS rebind between check and connect (TOCTOU) can't swap in an internal
    // IP. A blocked URL is a permanent config error → fail without retry. The
    // outward error is generic: the detailed reason (and any resolved internal
    // address) stays on the WebhookUrlBlockedError, never in the result.
    const guard = this.options.ssrf === false ? undefined : (this.options.ssrf ?? {})
    let pinned: ValidatedAddress | null = null
    let validated = guard === undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // One deadline per attempt, covering DNS resolution AND the request: a
      // resolver that never answers must not hold the delivery (or the outbox
      // flush waiting on it) past `timeoutMs`.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      attemptStart = performance.now()
      attemptAt = new Date()
      try {
        // Resolve on the first attempt — and again before every retry when a
        // custom fetchImpl doesn't honour the pin (it re-resolves on its own, so
        // a rebind during backoff is at least caught here). A resolution that
        // timed out is retried like any transient failure.
        if (guard !== undefined && (!validated || this.unpinnedFetch)) {
          try {
            pinned = (
              await untilAborted(resolveAndValidate(endpoint.url, guard), controller.signal, () => new Error(DNS_TIMEOUT_ERROR))
            ).pinned
            validated = true
          } catch (error) {
            if (error instanceof WebhookUrlBlockedError) {
              const message = error.dnsDerived ? DNS_BLOCKED_ERROR : error.message
              return done({ endpointId: endpoint.id, ok: false, attempts, error: message, retryable: false })
            }
            if (controller.signal.aborted) {
              attempts += 1 // the attempt spent its whole deadline resolving
              lastError = DNS_TIMEOUT_ERROR
              attempted({ ok: false, error: DNS_TIMEOUT_ERROR })
              if (attempt < this.maxRetries) await this.sleep(this.backoffMs * 2 ** attempt)
              continue
            }
            throw error
          }
        }
        attempts += 1
        try {
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            [this.headerNames.event]: event,
            [this.headerNames.delivery]: deliveryId,
          }
          // Signed with the time of THIS attempt: a retry after a long backoff must
          // still fall inside the receiver's replay tolerance. During a rotation
          // grace window the header carries one `v1=` per secret (current first).
          if (secrets.length > 0) headers[this.headerNames.signature] = signPayload(body, secrets, this.now())

          // `redirect: 'manual'` so a 3xx can't bounce the request to an internal
          // address (or a refused port) that bypassed the SSRF check on the
          // original URL. The socket is pinned to the validated `pinned` address.
          const response = await this.send(endpoint.url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal }, pinned)
          lastStatus = response.status
          // Only the status matters: release an injected fetch's body instead of
          // leaving it (and its socket) open until garbage collection.
          try {
            void (response as { body?: { cancel?: () => Promise<void> } | null }).body?.cancel?.()?.catch(() => {})
          } catch {
            // a locked/consumed body is already being handled by its owner
          }
          if (response.ok) {
            attempted({ ok: true, status: response.status })
            return done({ endpointId: endpoint.id, ok: true, status: response.status, attempts })
          }
          // A redirect is refused, not followed (opaqueredirect ⇒ status 0).
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            attempted({ ok: false, status: response.status, error: 'redirect refused' })
            return done({ endpointId: endpoint.id, ok: false, status: response.status, attempts, error: 'redirect refused', retryable: false })
          }
          // 4xx is a client error — do not retry inline. 408/429 are worth a
          // later retry (outbox), every other 4xx is permanent.
          if (response.status < 500) {
            const retryable = response.status === 408 || response.status === 429
            attempted({ ok: false, status: response.status, error: `HTTP ${response.status}` })
            return done({ endpointId: endpoint.id, ok: false, status: response.status, attempts, error: `HTTP ${response.status}`, retryable })
          }
          attempted({ ok: false, status: response.status, error: `HTTP ${response.status}` })
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          attempted({ ok: false, error: lastError })
        }
      } finally {
        clearTimeout(timer)
      }
      if (attempt < this.maxRetries) await this.sleep(this.backoffMs * 2 ** attempt)
    }

    return done({
      endpointId: endpoint.id,
      ok: false,
      attempts,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      ...(lastError !== undefined ? { error: lastError } : {}),
      retryable: true,
    })
  }
}
