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
 *    cannot walk out of the allowlist or spin forever. A hop to a **different
 *    host** also drops the caller's credential headers: `/content` on Graph
 *    and a Google Drive download both redirect to a CDN that already holds a
 *    pre-signed URL, and handing it a provider-wide bearer token as well is a
 *    credential given to a host that never needed it.
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
  /**
   * Request body.
   *
   * A `Readable` is streamed straight onto the socket and never buffered.
   * Phase 1 allowed only `string | Buffer`, which made {@link DriveProvider.upload}
   * unimplementable without holding a whole file in memory — Dropbox's
   * single-shot `files/upload` takes up to 150 MB. A streamed body is **not
   * replayable**, so a redirect destroys it instead of silently re-sending
   * nothing; the content endpoints these adapters post to do not redirect.
   */
  body?: string | Buffer | Readable
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
  /**
   * Reads a vendor-specific retry hint out of a 429/503 body — see
   * {@link DriveProvider.retryAfterFromBody}.
   *
   * At most {@link RATE_LIMIT_BODY_BYTES} of the body are read before it is
   * abandoned, so an error path can never be turned into an unbounded read.
   * A `Retry-After` header, when present, wins.
   */
  retryAfterFromBody?: (body: string) => number | undefined
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
  init: {
    method: string
    headers: Record<string, string>
    body?: string | Buffer | Readable
    signal?: AbortSignal
    timeoutMs: number
  },
  pinned: ValidatedAddress | null,
) => Promise<{ status: number; headers: Record<string, string>; body: Readable }>

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_REDIRECTS = 3
/**
 * How much of a 429/503 body may be read to find a vendor retry hint.
 *
 * Small on purpose: the whole point of destroying a rate-limited body is that a
 * throttled provider must not be able to make us read more, and a provider that
 * answers 429 with a gigabyte is exactly the case this bound exists for.
 */
export const RATE_LIMIT_BODY_BYTES = 8 * 1024

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

/**
 * Reads at most {@link RATE_LIMIT_BODY_BYTES} of a rate-limited body and asks
 * the provider's parser for a hint. Anything that goes wrong — a truncated
 * body, a parser that throws, a socket that dies — produces `undefined` and the
 * caller falls back to its own backoff schedule. An error path must not be able
 * to raise a second, different error.
 */
async function readRateLimitHint(
  body: Readable,
  parse: (body: string) => number | undefined,
): Promise<number | undefined> {
  try {
    const chunks: Buffer[] = []
    let seen = 0
    for await (const chunk of body) {
      chunks.push(chunk as Buffer)
      seen += (chunk as Buffer).length
      if (seen >= RATE_LIMIT_BODY_BYTES) break
    }
    const hint = parse(Buffer.concat(chunks).subarray(0, RATE_LIMIT_BODY_BYTES).toString('utf8'))
    return typeof hint === 'number' && Number.isFinite(hint) && hint >= 0 ? hint : undefined
  } catch {
    return undefined
  } finally {
    body.destroy()
  }
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
    // Mutable, because a redirect to another host must not carry the caller's
    // credentials with it. See `stripCredentials`.
    let headers: Record<string, string> = { ...init.headers }

    for (let hop = 0; ; hop++) {
      const url = parseTarget(target, options.provider)
      if (!hostAllowed(url.hostname, options.allowedHosts)) {
        throw new DriveHostNotAllowedError(url.hostname, options.provider)
      }
      // The refusal is re-raised as our own error, carrying the HOST and
      // nothing else. `resolveAndValidate` reports the URL it refused — right
      // for a webhook endpoint an operator configured, wrong here, where the
      // URL being validated is routinely a pre-signed download URL that is
      // itself a bearer credential for the file (`@microsoft.graph.downloadUrl`,
      // Google's `googleusercontent.com` redirect target). That message reaches
      // `drive:sync_failed`, an app's logger and `@basaltkit/audit` verbatim.
      // No `cause`, deliberately: a cause chain puts it straight back into
      // anything that inspects or serialises the error.
      let validated: Awaited<ReturnType<typeof resolveAndValidate>>
      try {
        validated = await resolveAndValidate(target, {
          allowedSchemes: [...(options.allowedSchemes ?? ['https:'])],
          ...(options.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
          ...(options.lookup ? { lookup: options.lookup } : {}),
        })
      } catch {
        throw new DriveHostNotAllowedError(url.hostname, options.provider, 'the address failed validation')
      }

      const response = await transport(
        validated.url,
        {
          method,
          headers: {
            // Deliberately no accept-encoding: see note 5 at the top. A body we
            // never inflate cannot be a decompression bomb.
            accept: 'application/json',
            ...headers,
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
        // A `Location` can itself be a pre-signed URL, so a malformed one is
        // refused without quoting it back.
        let next: URL
        try {
          next = new URL(response.headers['location'] as string, validated.url)
        } catch {
          throw new DriveHostNotAllowedError(url.hostname, options.provider, 'the redirect target could not be parsed')
        }
        // A hop to a DIFFERENT host does not get the caller's credentials.
        // This is not hypothetical: Graph's `/content` answers 302 to a CDN and
        // Google Drive redirects to `googleusercontent.com`, and forwarding the
        // `Authorization` header would present a provider-wide bearer token to
        // a host that already has a pre-signed URL and needs nothing. The
        // allowlist bounds which hosts those are; it does not make them
        // entitled to the token.
        if (next.host !== url.host) headers = stripCredentials(headers)
        target = next.toString()
        // A redirected non-GET is replayed as GET without a body, matching what
        // every HTTP client does for 303 and what these APIs actually mean.
        // A streamed body cannot be replayed at all, so it is destroyed rather
        // than left dangling on a socket nobody is reading.
        method = 'GET'
        if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) body.destroy()
        body = undefined
        continue
      }

      if (response.status === 429 || response.status === 503) {
        // The header is the interoperable answer and wins. Only when it is
        // absent is a bounded prefix of the body read, and only when the
        // provider declared a parser for it: Dropbox routinely answers 429 with
        // no header and `retry_after` in the JSON instead.
        const headerHint = parseRetryAfter(response.headers['retry-after'])
        let hint = headerHint
        if (hint === undefined && options.retryAfterFromBody) {
          hint = await readRateLimitHint(response.body, options.retryAfterFromBody)
        } else {
          response.body.destroy()
        }
        throw new DriveRateLimitedError(hint, options.provider)
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
 * Parses a target URL without letting the URL escape into the failure.
 *
 * Node's `ERR_INVALID_URL` carries the offending string on `error.input`, which
 * a logger that prints a whole error object will happily emit — and the string
 * here can be a provider download URL, which is a credential. There is no
 * hostname to report for something that did not parse, so the refusal says so.
 */
function parseTarget(target: string, provider: string): URL {
  try {
    return new URL(target)
  } catch {
    throw new DriveHostNotAllowedError('(unparseable url)', provider, 'the url could not be parsed')
  }
}

/**
 * Headers that must not survive a redirect to another host.
 *
 * Matched case-insensitively, because a caller writes `Authorization` as often
 * as `authorization` and only one of the two spellings being dropped is worse
 * than neither.
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

function stripCredentials(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) kept[key] = value
  }
  return kept
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
    const body = init.body
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      // Streamed upload: piped, never buffered, and a source that fails takes
      // the request down with it rather than sending a truncated file the
      // provider would happily accept as complete.
      body.on('error', (error) => request.destroy(error))
      body.pipe(request)
      return
    }
    if (body !== undefined) request.write(body)
    request.end()
  })
