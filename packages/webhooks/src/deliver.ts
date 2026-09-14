import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveAndValidate, WebhookUrlBlockedError, type SsrfGuardOptions, type ValidatedAddress } from './ssrf.js'
import { pinnedRequest } from './pinned-fetch.js'
import type { WebhookEndpoint } from './store.js'

/**
 * Non-standard init key carrying the SSRF-validated address the connection is
 * pinned to. The built-in transport uses the explicit argument; an injected
 * `fetchImpl` (which can't take extra positional args) can read it from init.
 */
export const PINNED_ADDRESS: unique symbol = Symbol('basalt.webhooks.pinnedAddress')

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
 * `t`, no `v1`) is `false`. Never throws.
 */
export function verifySignature(header: string, body: string, secret: string, toleranceSeconds = 300, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
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
}

export interface WebhookDelivererOptions {
  /** Default signing secret (an endpoint's own `secret` overrides it). */
  secret?: string
  /** Retries after the first attempt. Default 3. */
  maxRetries?: number
  /** Base backoff in ms, doubled per attempt. Default 500. */
  backoffMs?: number
  /** Per-attempt timeout in ms. Default 10s. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
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
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: WebhookDelivererOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3
    this.backoffMs = options.backoffMs ?? 500
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.fetchImpl = options.fetchImpl
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
  }

  /**
   * Sends one request. With no injected `fetchImpl`, uses the built-in transport
   * that pins the socket to `pinned` (rebind-proof). An injected `fetchImpl`
   * receives the pin on the init object under {@link PINNED_ADDRESS} so callers
   * that pin via a dispatcher — and tests — can observe/use it.
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

  async deliver(endpoint: WebhookEndpoint, event: string, data: unknown): Promise<DeliveryResult> {
    const timestamp = this.now()
    const body = JSON.stringify({ event, data, sentAt: new Date(timestamp * 1000).toISOString() })
    const secret = endpoint.secret ?? this.options.secret

    // SSRF guard (unless explicitly disabled): resolve+validate the URL ONCE up
    // front and remember the validated address. The connection is later pinned to
    // it so a DNS rebind between check and connect (TOCTOU) can't swap in an
    // internal IP. A blocked URL is a permanent config error → fail without retry.
    let pinned: ValidatedAddress | null = null
    if (this.options.ssrf !== false) {
      try {
        pinned = (await resolveAndValidate(endpoint.url, this.options.ssrf ?? {})).pinned
      } catch (error) {
        if (error instanceof WebhookUrlBlockedError) {
          return { endpointId: endpoint.id, ok: false, attempts: 0, error: error.message }
        }
        throw error
      }
    }

    let attempts = 0
    let lastStatus: number | undefined
    let lastError: string | undefined

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      attempts += 1
      try {
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-basalt-event': event,
        }
        if (secret) headers['x-basalt-signature'] = signPayload(body, secret, timestamp)

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
          // `redirect: 'manual'` so a 3xx can't bounce the request to an internal
          // address that bypassed the SSRF check on the original URL. The socket
          // is pinned to the validated `pinned` address (rebind-proof).
          const response = await this.send(endpoint.url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal }, pinned)
          lastStatus = response.status
          if (response.ok) return { endpointId: endpoint.id, ok: true, status: response.status, attempts }
          // A redirect is refused, not followed (opaqueredirect ⇒ status 0).
          if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
            return { endpointId: endpoint.id, ok: false, status: response.status, attempts, error: 'redirect refused' }
          }
          // 4xx is a client error — do not retry.
          if (response.status < 500) {
            return { endpointId: endpoint.id, ok: false, status: response.status, attempts, error: `HTTP ${response.status}` }
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
    }
  }
}
