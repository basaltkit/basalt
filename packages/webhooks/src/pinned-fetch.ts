import http from 'node:http'
import https from 'node:https'
import { pinnedLookup, type ValidatedAddress } from './ssrf.js'

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
      res.resume() // drain so the socket is freed; we only need the status line
      resolve({ ok: status >= 200 && status < 300, status, type: 'basic' })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}
