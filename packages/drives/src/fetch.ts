import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { pinnedLookup, resolveAndValidate, type ValidatedAddress } from '@basaltkit/webhooks'
import { DriveContentTooLargeError, DriveHostNotAllowedError, DriveRateLimitedError } from './errors.js'

/**
 * The only network door an adapter gets.
 *
 * Talking to a third-party file API is a hostile surface in a way that a
 * configured webhook endpoint is not: the *provider's own responses* hand us
 * URLs we are then expected to fetch. A Graph `driveItem` carries
 * `@microsoft.graph.downloadUrl`; `/content` answers 302 to a CDN host. Those
 * are attacker-influenced data — a tenant who can place a file in a shared
 * folder influences what the provider says about it — so every hop gets the
 * same treatment as untrusted input:
 *
 * 1. **Host allowlist** — the provider declares every host it may reach
 *    ({@link DriveProvider.allowedHosts}). Checked before DNS, and again after
 *    every redirect.
 * 2. **SSRF validation + IP pinning** — delegated to `@basaltkit/webhooks`'
 *    guard (`resolveAndValidate` / `pinnedLookup`), which refuses private,
 *    loopback, link-local (`169.254.169.254`), CGNAT, ULA and reserved
 *    addresses, resolves once, checks every answer, and pins the socket to the
 *    validated IP so a DNS rebind cannot swap in an internal address at connect
 *    time. Reused rather than reimplemented — IP-range classification is the
 *    last code that should exist twice in a repository.
 * 3. **Manual redirects** — never followed automatically. Each hop is
 *    re-validated from scratch and the hop count is capped, so a redirect chain
 *    cannot walk out of the allowlist or spin forever.
 * 4. **Byte cap** — enforced *while streaming*, so an oversized body (or a
 *    decompression bomb) is abandoned mid-flight rather than after it has been
 *    written somewhere.
 * 5. **No transparent decompression** — no `accept-encoding` is added, and a
 *    `content-encoding` response is not inflated here. The cap therefore
 *    applies to real bytes on the wire, which is the only number a bomb cannot
 *    lie about.
 * 6. **Timeout** — on the whole exchange, not just the connect.
 */

/** A network call that has passed every check above. */
export type GuardedFetch = (url: string, init?: GuardedRequestInit) => Promise<GuardedResponse>

export interface GuardedRequestInit {
  method?: string
  headers?: Record<string, string>
  /** Request body. A string or buffer only — an adapter that needs to stream a body uses `upload`. */
  body?: string | Buffer
  signal?: AbortSignal
  /**
   * Overrides the default byte cap for this call. Metadata calls want a small
   * cap; a download wants the import cap.
   */
  maxBytes?: number
  /** Overrides the default timeout for this call. */
  timeoutMs?: number
}

export interface GuardedResponse {
  status: number
  ok: boolean
  /** Lowercased response headers. */
  headers: Record<string, string>
  /** The body as a stream. Consume it or call `destroy()`. Capped at `maxBytes`. */
  body: Readable
  /** Reads the whole (capped) body as text. */
  text(): Promise<string>
  /** Reads the whole (capped) body and parses it as JSON. */
  json<T = unknown>(): Promise<T>
  /** Abandons the body without reading it. */
  destroy(): void
}

export interface DriveFetchOptions {
  /** Hosts the caller may reach. Exact host, or `.suffix` for subdomains of it. */
  allowedHosts: readonly string[]
  /** Provider name, used only in error messages. */
  provider: string
  /** Default byte cap. Default 100 MiB. */
  maxBytes?: number
  /** Default whole-exchange timeout. Default 30 s. */
  timeoutMs?: number
  /** Redirect hops allowed. Default 3. */
  maxRedirects?: number
  /** Escape hatch for a self-hosted provider on a private network. Off by default. */
  allowPrivateHosts?: boolean
  /**
   * URL schemes the caller may use. Default `['https:']` — every one of the
   * cloud providers this package targets is https-only, and a bearer token on
   * a cleartext connection is a token on the wire.
   *
   * Widening it is deliberate and separate from {@link allowPrivateHosts}: an
   * operator pointing this at a self-hosted server inside their own network
   * has to say so in one place a reviewer can find, rather than getting
   * cleartext as a side effect of allowing a private address.
   */
  allowedSchemes?: readonly string[]
  /** Injected resolver (tests). Matches `@basaltkit/webhooks`' guard option. */
  lookup?: (host: string) => Promise<{ address: string; family?: number }[]>
  /**
   * Injected transport (tests). Receives an already-validated target. Production
   * leaves it unset and gets the pinned node:http/https client.
   */
  transport?: Transport
}

/** What performs the validated request. Replaceable so the guard can be tested without sockets. */
export type Transport = (
  url: URL,
  init: { method: string; headers: Record<string, string>; body?: string | Buffer; signal?: AbortSignal; timeoutMs: number },
  pinned: ValidatedAddress | null,
) => Promise<{ status: number; headers: Record<string, string>; body: Readable }>

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 3

/**
 * Host allowlist check.
 *
 * A bare entry matches that host exactly. A leading dot matches subdomains
 * **only** — `.googleusercontent.com` allows `abc.googleusercontent.com` but
 * not `googleusercontent.com` itself, and critically not
 * `evilgoogleusercontent.com`, which a naive `endsWith` would wave through.
 */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  for (const entry of allowed) {
    const candidate = entry.toLowerCase()
    if (candidate.startsWith('.')) {
      if (normalized.endsWith(candidate) && normalized.length > candidate.length) return true
    } else if (normalized === candidate) {
      return true
    }
  }
  return false
}

/**
 * Parses `Retry-After`, which providers send either as seconds or as an
 * HTTP-date. Returns ms, or `undefined` when the header is absent or unusable.
 */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}

/**
 * Wraps a readable so it errors past `maxBytes` instead of delivering them.
 *
 * The source is destroyed on trip, which is what makes an oversized download
 * cost the abandoned prefix rather than the whole file.
 */
export function capStream(source: Readable, maxBytes: number): Readable {
  let seen = 0
  const capped = new Readable({
    read() {
      source.resume()
    },
    destroy(error, callback) {
      source.destroy()
      callback(error)
    },
  })
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length
    if (seen > maxBytes) {
      source.destroy()
      capped.destroy(new DriveContentTooLargeError(maxBytes))
      return
    }
    if (!capped.push(chunk)) source.pause()
  })
  source.on('end', () => capped.push(null))
  source.on('error', (error) => capped.destroy(error))
  return capped
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Builds the guarded fetch an adapter is handed on every call. */
export function createDriveFetch(options: DriveFetchOptions): GuardedFetch {
  const defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const transport = options.transport ?? pinnedTransport

  return async function guardedFetch(rawUrl: string, init: GuardedRequestInit = {}): Promise<GuardedResponse> {
    const maxBytes = init.maxBytes ?? defaultMaxBytes
    const timeoutMs = init.timeoutMs ?? defaultTimeout
    let target = rawUrl
    let method = init.method ?? 'GET'
    let body = init.body

    for (let hop = 0; ; hop++) {
      const url = new URL(target)
      if (!hostAllowed(url.hostname, options.allowedHosts)) {
        throw new DriveHostNotAllowedError(url.hostname, options.provider)
      }
      const validated = await resolveAndValidate(target, {
        allowedSchemes: [...(options.allowedSchemes ?? ['https:'])],
        ...(options.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
        ...(options.lookup ? { lookup: options.lookup } : {}),
      })

      const response = await transport(
        validated.url,
        {
          method,
          headers: {
            // Deliberately no accept-encoding: see note 5 at the top. A body we
            // never inflate cannot be a decompression bomb.
            accept: 'application/json',
            ...init.headers,
          },
          ...(body !== undefined ? { body } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
          timeoutMs,
        },
        validated.pinned,
      )

      if (response.status >= 300 && response.status < 400 && response.headers['location'] !== undefined) {
        response.body.destroy()
        if (hop >= maxRedirects) {
          throw new DriveHostNotAllowedError(`${url.hostname} (redirect depth ${hop + 1})`, options.provider)
        }
        // Resolve relative Locations against the hop we are on, then loop — the
        // next iteration re-runs the allowlist and the SSRF guard from scratch.
        target = new URL(response.headers['location'] as string, validated.url).toString()
        // A redirected non-GET is replayed as GET without a body, matching what
        // every HTTP client does for 303 and what these APIs actually mean.
        method = 'GET'
        body = undefined
        continue
      }

      if (response.status === 429 || response.status === 503) {
        response.body.destroy()
        throw new DriveRateLimitedError(parseRetryAfter(response.headers['retry-after']), options.provider)
      }

      const capped = capStream(response.body, maxBytes)
      let consumed: Promise<Buffer> | undefined
      const read = (): Promise<Buffer> => (consumed ??= collect(capped))
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: response.headers,
        body: capped,
        async text() {
          return (await read()).toString('utf8')
        },
        async json<T>() {
          const text = (await read()).toString('utf8')
          return (text === '' ? {} : JSON.parse(text)) as T
        },
        destroy() {
          capped.destroy()
        },
      }
    }
  }
}

/**
 * The production transport: node's own http/https client with the agent
 * `lookup` pinned to the already-validated IP. The request still carries the
 * real hostname, so `Host` and TLS SNI stay correct while the socket can only
 * reach the address the guard approved.
 *
 * Unlike `@basaltkit/webhooks`' internal `pinnedRequest`, this one hands the
 * response stream back instead of destroying it — a download is the whole point
 * here, and the byte cap rather than immediate destruction is what bounds it.
 */
const pinnedTransport: Transport = (url, init, pinned) =>
  new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const mod = isHttps ? https : http
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const request = mod.request(
      {
        method: init.method,
        hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: init.headers,
        ...(init.signal ? { signal: init.signal } : {}),
        ...(pinned ? { lookup: pinnedLookup(pinned.address, pinned.family) } : {}),
      },
      (response) => {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
        }
        resolve({ status: response.statusCode ?? 0, headers, body: response })
      },
    )
    // The timeout covers the whole exchange: a provider that accepts the
    // connection and then trickles one byte a minute is the cheapest way to pin
    // a worker forever, and a connect-only timeout does not catch it.
    request.setTimeout(init.timeoutMs, () => request.destroy(new Error('drive request timed out')))
    request.on('error', reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
