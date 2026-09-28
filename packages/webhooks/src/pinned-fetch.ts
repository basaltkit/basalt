import http from 'node:http'
import https from 'node:https'
import { pinnedLookup, type ValidatedAddress } from './ssrf.js'

/**
 * Non-standard init key carrying the SSRF-validated address the connection must
 * be pinned to. The built-in transport uses it directly; an injected `fetchImpl`
 * receives it on its init object and must honour it to stay rebind-proof —
 * {@link pinnedFetch} does, so a wrapper that delegates to it keeps the pin.
 */
export const PINNED_ADDRESS: unique symbol = Symbol('basalt.webhooks.pinnedAddress')

/** The subset of a `fetch` init the deliverer relies on. */
export interface PinnedRequestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/** The subset of a `Response` the deliverer reads back. */
export interface PinnedResponse {
  ok: boolean
  status: number
  /** Fetch parity: 'basic' for a normal response (never 'opaqueredirect' — node never auto-follows). */
  type: string
}

/**
 * Performs the outbound POST over the built-in http/https client, pinning the
 * TCP connection to `pinned.address` via the agent `lookup` option. The request
 * still carries the original hostname, so the `Host` header and TLS SNI stay
 * correct (vhost / certificate validation), while the socket can only reach the
 * already-validated IP — a rebind can't swap in an internal address.
 *
 * Redirects are never followed (node does not auto-follow); a 3xx is returned
 * verbatim for the caller to refuse, matching `redirect: 'manual'` semantics.
 */
export function pinnedRequest(url: URL, init: PinnedRequestInit, pinned: ValidatedAddress | null): Promise<PinnedResponse> {
  return new Promise<PinnedResponse>((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? https : http
    const hostname = url.hostname.replace(/^\[|\]$/g, '') // strip IPv6 brackets for Host/SNI

    const options: https.RequestOptions = {
      method: init.method ?? 'POST',
      hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: init.headers,
      ...(init.signal ? { signal: init.signal } : {}),
      // Pin: connect to the validated IP regardless of what the hostname would
      // now resolve to. When pinning is skipped (allowPrivateHosts) fall back to
      // the platform resolver.
      ...(pinned ? { lookup: pinnedLookup(pinned.address, pinned.family) } : {}),
    }

    const req = mod.request(options, (res) => {
      const status = res.statusCode ?? 0
      // Only the status line matters. Destroy the response (and its socket)
      // instead of draining the body: draining is unbounded in time and bytes, so
      // a receiver trickling an endless body would pin sockets/FDs indefinitely.
      res.destroy()
      resolve({ ok: status >= 200 && status < 300, status, type: 'basic' })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/**
 * A `fetch`-compatible function over the built-in pinned transport: it connects
 * to `init[PINNED_ADDRESS]` (the SSRF-validated IP the deliverer resolved) while
 * keeping the original hostname for the `Host` header and TLS SNI/certificate
 * checks. Use it as the delegate of a custom `fetchImpl` (instrumentation,
 * logging, metrics) so the wrapper does not lose DNS pinning:
 *
 * ```ts
 * new WebhookDeliverer({
 *   fetchImpl: async (url, init) => { const t = Date.now(); try { return await pinnedFetch(url, init) } finally { metrics.observe(Date.now() - t) } },
 *   fetchImplPinsAddress: true,
 * })
 * ```
 *
 * Only what the deliverer sends is supported: a string/URL target, string body,
 * plain-object or `Headers` headers. The response carries the status only (the
 * body is discarded unread, as the deliverer never reads it). With no pin on
 * init (SSRF guard disabled or `allowPrivateHosts`), the platform resolver is used.
 */
export async function pinnedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    throw new TypeError('pinnedFetch(): pass the URL and init separately, not a Request object')
  }
  const url = new URL(String(input))
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
    throw new TypeError('pinnedFetch(): only a string body is supported')
  }
  const headers: Record<string, string> = {}
  new Headers(init.headers ?? {}).forEach((value, key) => {
    headers[key] = value
  })
  const pinned = ((init as Record<symbol, unknown>)[PINNED_ADDRESS] ?? null) as ValidatedAddress | null
  const res = await pinnedRequest(
    url,
    {
      method: init.method ?? 'POST',
      headers,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    },
    pinned,
  )
  // `Response` only accepts 200–599; anything else (1xx) is not a usable reply.
  if (res.status < 200 || res.status > 599) throw new Error(`unexpected HTTP status ${res.status}`)
  return new Response(null, { status: res.status })
}
