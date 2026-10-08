import type { Readable } from 'node:stream'
import {
  capStream as capGuardedStream,
  createGuardedFetch,
  type GuardedFetch,
  type GuardedFetchError,
  type GuardedRequestInit,
  type GuardedResponse,
  type GuardedTransport,
} from '@basaltkit/webhooks'
import { DriveContentTooLargeError, DriveHostNotAllowedError, DriveRateLimitedError } from './errors.js'

export { hostAllowed } from '@basaltkit/webhooks'

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
 *    public `createGuardedFetch` (`resolveAndValidate` / `pinnedLookup`
 *    underneath), which refuses private,
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
 * 6. **Timeouts** — two of them, because one number cannot bound both a
 *    stalled socket and a slow-but-steady one:
 *    - `timeoutMs` is an **inactivity** timeout on the socket *and* a hard
 *      wall-clock bound on each hop's wait for response headers, so a server
 *      that trickles its headers a byte at a time cannot hold a worker;
 *    - `deadlineMs` (off by default) bounds the **whole exchange**, body
 *      included. It is opt-in because a legitimate 100 MiB download on a slow
 *      link takes minutes, and only the app knows how many it can wait.
 */

/**
 * A network call that has passed every check above. The same contract as
 * `@basaltkit/webhooks`' `GuardedFetch`, re-exported under the names adapters
 * already import.
 */
export type { GuardedFetch, GuardedRequestInit, GuardedResponse }

/** What performs the validated request. Replaceable so the guard can be tested without sockets. */
export type Transport = GuardedTransport

export interface DriveFetchOptions {
  /** Hosts the caller may reach. Exact host, or `.suffix` for subdomains of it. */
  allowedHosts: readonly string[]
  /** Provider name, used only in error messages. */
  provider: string
  /** Default byte cap. Default 100 MiB. */
  maxBytes?: number
  /**
   * Socket **inactivity** timeout, and the wall-clock bound on each hop's wait
   * for response headers. Default 30 s.
   *
   * Not a bound on the whole exchange: a body that keeps delivering a byte
   * every few seconds never trips it. That is {@link deadlineMs}.
   */
  timeoutMs?: number
  /**
   * Wall-clock bound on the **whole exchange** — every redirect hop, the
   * headers and the entire body. Off by default: a large download on a slow
   * link is legitimate, and only the app knows how long it can wait. Set it
   * when a worker must never be pinned by a provider (or a CDN) that trickles.
   */
  deadlineMs?: number
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

export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000
/**
 * How much of a 429/503 body may be read to find a vendor retry hint.
 *
 * Small on purpose: the whole point of destroying a rate-limited body is that a
 * throttled provider must not be able to make us read more, and a provider that
 * answers 429 with a gigabyte is exactly the case this bound exists for.
 */
export const RATE_LIMIT_BODY_BYTES = 8 * 1024

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
 * Wraps a readable so it errors with {@link DriveContentTooLargeError} past
 * `maxBytes` instead of delivering them — used by the adapters to bound an
 * upload. The source is destroyed on trip.
 */
export function capStream(source: Readable, maxBytes: number): Readable {
  return capGuardedStream(source, maxBytes, () => new DriveContentTooLargeError(maxBytes))
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

/**
 * The guard's refusals, in this package's vocabulary.
 *
 * Every SSRF refusal becomes {@link DriveHostNotAllowedError} carrying the HOST
 * and a fixed reason — never the URL, which on this package's hot path is a
 * pre-signed download link and therefore a credential. No `cause`, on purpose.
 */
function toDriveError(provider: string): (error: GuardedFetchError) => Error {
  return (error) => {
    switch (error.kind) {
      case 'SSRF_BLOCKED':
        return new DriveHostNotAllowedError(error.info.host ?? '(unknown host)', provider, error.info.reason)
      case 'TOO_MANY_REDIRECTS':
        return new DriveHostNotAllowedError(`${error.info.host ?? '(unknown host)'} (redirect depth ${error.info.redirects ?? 0})`, provider)
      case 'BODY_TOO_LARGE':
        return new DriveContentTooLargeError(error.info.maxBytes ?? 0)
      case 'TIMEOUT':
        return new Error(error.info.phase === 'deadline' ? 'drive request exceeded its deadline' : 'drive request timed out')
    }
  }
}

/**
 * Builds the guarded fetch an adapter is handed on every call.
 *
 * The transport itself is `@basaltkit/webhooks`' public `createGuardedFetch`,
 * which owns the SSRF guard; this adds what is specific to a drive provider —
 * the provider's host allowlist, the `DRIVE_*` errors, and turning a 429/503
 * into {@link DriveRateLimitedError} with the vendor's retry hint.
 */
export function createDriveFetch(options: DriveFetchOptions): GuardedFetch {
  const guarded = createGuardedFetch({
    allowedHosts: options.allowedHosts,
    allowedSchemes: options.allowedSchemes ?? ['https:'],
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
    ...(options.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    defaultHeaders: { accept: 'application/json' },
    mapError: toDriveError(options.provider),
  })

  const defaultMaxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

  return async function guardedFetch(rawUrl: string, init: GuardedRequestInit = {}): Promise<GuardedResponse> {
    // A throttle's retry hint may sit in the first RATE_LIMIT_BODY_BYTES of the
    // body even when the caller asked for a smaller cap (a metadata call), so
    // the transport is never capped below that; the caller's own cap is then
    // re-applied to every response that is handed back.
    const maxBytes = init.maxBytes ?? defaultMaxBytes
    const response = await guarded(rawUrl, { ...init, maxBytes: Math.max(maxBytes, RATE_LIMIT_BODY_BYTES) })
    if (response.status === 429 || response.status === 503) {
      // The header is the interoperable answer and wins. Only when it is
      // absent is a bounded prefix of the body read, and only when the
      // provider declared a parser for it: Dropbox routinely answers 429 with
      // no header and `retry_after` in the JSON instead.
      let hint = parseRetryAfter(response.headers['retry-after'])
      if (hint === undefined && options.retryAfterFromBody) {
        hint = await readRateLimitHint(response.body, options.retryAfterFromBody)
      } else {
        response.destroy()
      }
      throw new DriveRateLimitedError(hint, options.provider)
    }
    return maxBytes >= RATE_LIMIT_BODY_BYTES ? response : recapped(response, maxBytes)
  }
}

/** The same response with a tighter byte cap on its body. */
function recapped(response: GuardedResponse, maxBytes: number): GuardedResponse {
  const body = capStream(response.body, maxBytes)
  let consumed: Promise<Buffer> | undefined
  const read = (): Promise<Buffer> =>
    (consumed ??= (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of body) chunks.push(chunk as Buffer)
      return Buffer.concat(chunks)
    })())
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
    async text() {
      return (await read()).toString('utf8')
    },
    async json<T>() {
      const text = (await read()).toString('utf8')
      return (text === '' ? {} : JSON.parse(text)) as T
    },
    async arrayBuffer() {
      const bytes = await read()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    },
    destroy() {
      body.destroy()
    },
  }
}
