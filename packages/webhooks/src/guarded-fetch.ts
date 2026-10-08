import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import { BasaltError } from '@basaltkit/core'
import { pinnedLookup, resolveAndValidate, type ValidatedAddress } from './ssrf.js'

/**
 * A **streaming** outbound HTTP client for URLs you do not control — a
 * tenant-supplied import URL, a provider's download link, an avatar to fetch.
 *
 * `pinnedFetch` (the webhook deliverer's transport) destroys the response body,
 * because a webhook delivery only needs the status. This one hands the body
 * back as a stream, which is what a download needs, and bounds it instead:
 *
 * 1. **Host allowlist** (optional) — exact host, or `.suffix` for subdomains
 *    only (`.googleusercontent.com` does not match `evilgoogleusercontent.com`).
 *    Checked before DNS, and again after every redirect.
 * 2. **SSRF validation + IP pinning** — {@link resolveAndValidate} refuses
 *    private, loopback, link-local (`169.254.169.254`), CGNAT, ULA, reserved
 *    and IPv4-embedded-in-IPv6 addresses, checks every resolved answer, and the
 *    socket is pinned to the validated IP so a DNS rebind cannot swap one in.
 * 3. **Manual redirects** — never followed automatically; every hop is
 *    re-validated from scratch, capped at `maxRedirects`, and a hop to a
 *    **different host** drops `authorization`, `cookie` and
 *    `proxy-authorization`.
 * 4. **Byte cap enforced while streaming** — the source is destroyed the moment
 *    the cumulative count passes `maxBytes`.
 * 5. **No transparent decompression** — no `accept-encoding` is sent and a
 *    `content-encoding` body is not inflated, so the cap applies to real bytes
 *    on the wire, which a decompression bomb cannot lie about.
 * 6. **Two timeouts** — `timeoutMs` (socket inactivity + each hop's wait for
 *    headers) and the opt-in `deadlineMs` for the whole exchange, body included.
 *
 * Every refusal is a {@link GuardedFetchError} that names the **host and a
 * fixed reason, never the URL**: the URL being refused is often a pre-signed
 * link that is itself a credential.
 */

/** The four ways the guard refuses or ends a request. */
export type GuardedFetchErrorKind = 'SSRF_BLOCKED' | 'BODY_TOO_LARGE' | 'TIMEOUT' | 'TOO_MANY_REDIRECTS'

/**
 * A request the guard refused or ended. `code` is `OUTBOUND_<kind>`.
 *
 * The message and fields never contain the URL, only the host — and there is
 * deliberately no `cause`, which would put the URL straight back into anything
 * that serialises the error.
 */
export class GuardedFetchError extends BasaltError {
  readonly status: number
  /** An HTTP client gets the code only: naming an internal host it was refused is an SSRF oracle. */
  readonly expose = false
  constructor(
    readonly kind: GuardedFetchErrorKind,
    message: string,
    readonly info: {
      host?: string
      reason?: string
      maxBytes?: number
      redirects?: number
      phase?: 'headers' | 'socket' | 'deadline'
    } = {},
  ) {
    super(`OUTBOUND_${kind}`, message, { details: { ...info } })
    this.status = kind === 'BODY_TOO_LARGE' ? 413 : kind === 'TIMEOUT' ? 504 : 502
  }
}

/** A request that passed every check above. */
export type GuardedFetch = (url: string, init?: GuardedRequestInit) => Promise<GuardedResponse>

export interface GuardedRequestInit {
  method?: string
  headers?: Record<string, string>
  /**
   * Request body. A `Readable` is streamed onto the socket and never buffered;
   * it is not replayable, so a redirect destroys it rather than re-sending
   * nothing.
   */
  body?: string | Buffer | Readable
  signal?: AbortSignal
  /** Overrides the default byte cap for this call. */
  maxBytes?: number
  /** Overrides the default inactivity / header timeout for this call. */
  timeoutMs?: number
  /** Overrides the default whole-exchange deadline for this call. */
  deadlineMs?: number
}

export interface GuardedResponse {
  status: number
  ok: boolean
  /** Lowercased response headers. */
  headers: Record<string, string>
  /** The body as a stream, capped at `maxBytes`. Consume it or call `destroy()`. */
  body: Readable
  /** Reads the whole (capped) body as text. */
  text(): Promise<string>
  /** Reads the whole (capped) body and parses it as JSON (`{}` for an empty body). */
  json<T = unknown>(): Promise<T>
  /** Reads the whole (capped) body as bytes. */
  arrayBuffer(): Promise<ArrayBuffer>
  /** Abandons the body without reading it. */
  destroy(): void
}

/** What performs one validated hop. Replaceable so the guard can be tested without sockets. */
export type GuardedTransport = (
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

export interface GuardedFetchOptions {
  /**
   * Hosts the client may reach: exact host, or `.suffix` for subdomains only.
   * Omitted, any public host passes (the SSRF guard still applies).
   */
  allowedHosts?: readonly string[]
  /** URL schemes allowed. Default `['https:']` (a trailing `:` is optional). */
  allowedSchemes?: readonly string[]
  /** Default byte cap for a response body. Required: there is no safe universal default. */
  maxBytes: number
  /** Socket inactivity timeout, and the bound on each hop's wait for headers. */
  timeoutMs: number
  /** Wall-clock bound on the whole exchange, body included. Off by default. */
  deadlineMs?: number
  /** Redirect hops allowed. Default 3. */
  maxRedirects?: number
  /** Escape hatch for a self-hosted target on a private network. Off by default. */
  allowPrivateHosts?: boolean
  /** Injected resolver (tests). Same as {@link resolveAndValidate}'s option. */
  lookup?: (host: string) => Promise<{ address: string; family?: number }[]>
  /** Injected transport (tests). Production gets the pinned node:http/https client. */
  transport?: GuardedTransport
  /** Headers sent on every hop unless the caller overrides them. Default `{}`. */
  defaultHeaders?: Record<string, string>
  /**
   * Converts the guard's refusals into the caller's own error type. Applied to
   * everything this client throws itself, including the error a capped body
   * stream is destroyed with. Used by `@basaltkit/drives` to keep its
   * `DRIVE_*` codes.
   */
  mapError?: (error: GuardedFetchError) => Error
}

const DEFAULT_MAX_REDIRECTS = 3

/**
 * Host allowlist check. A bare entry matches that host exactly; a leading dot
 * matches subdomains **only**, so `.googleusercontent.com` allows
 * `abc.googleusercontent.com` but neither the apex nor
 * `evilgoogleusercontent.com`.
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
 * Wraps a readable so it errors past `maxBytes` instead of delivering them.
 * The source is destroyed on trip, so an oversized body costs the abandoned
 * prefix rather than the whole thing.
 */
export function capStream(
  source: Readable,
  maxBytes: number,
  exceeded: () => Error = () =>
    new GuardedFetchError('BODY_TOO_LARGE', `The response exceeded the ${maxBytes}-byte limit and was abandoned.`, {
      maxBytes,
    }),
): Readable {
  return capWith(source, maxBytes, exceeded, (error) => error)
}

/** {@link capStream}, also translating the errors the source fails with. */
function capWith(
  source: Readable,
  maxBytes: number,
  exceeded: () => Error,
  mapSourceError: (error: Error) => Error,
): Readable {
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
      capped.destroy(exceeded())
      return
    }
    if (!capped.push(chunk)) source.pause()
  })
  source.on('end', () => capped.push(null))
  source.on('error', (error) => capped.destroy(mapSourceError(error)))
  return capped
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of body) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Builds a guarded, streaming fetch. See the module notes for what it enforces. */
export function createGuardedFetch(options: GuardedFetchOptions): GuardedFetch {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const transport = options.transport ?? pinnedStreamTransport
  const schemes = (options.allowedSchemes ?? ['https:']).map((s) => (s.endsWith(':') ? s : `${s}:`))
  const fail = (error: GuardedFetchError): Error => (options.mapError ? options.mapError(error) : error)
  /** Translates a guard error raised somewhere `fail` could not reach (the transport, the socket). */
  const translate = (error: unknown): unknown => (error instanceof GuardedFetchError ? fail(error) : error)
  const tooLarge = (maxBytes: number) => (): Error =>
    fail(
      new GuardedFetchError('BODY_TOO_LARGE', `The response exceeded the ${maxBytes}-byte limit and was abandoned.`, {
        maxBytes,
      }),
    )

  return async function guardedFetch(rawUrl: string, init: GuardedRequestInit = {}): Promise<GuardedResponse> {
    const maxBytes = init.maxBytes ?? options.maxBytes
    const timeoutMs = init.timeoutMs ?? options.timeoutMs
    const deadlineMs = init.deadlineMs ?? options.deadlineMs
    // One controller for the whole exchange: the caller's signal, the per-hop
    // header timer and the deadline all end the request through it.
    const exchange = new AbortController()
    const abortFromCaller = (): void => exchange.abort(init.signal?.reason)
    if (init.signal?.aborted) exchange.abort(init.signal.reason)
    else init.signal?.addEventListener('abort', abortFromCaller, { once: true })
    let deadline: ReturnType<typeof setTimeout> | undefined
    /** Set once the body is handed back, so the deadline can end it too. */
    let delivered: Readable | undefined
    const settle = (): void => {
      if (deadline !== undefined) clearTimeout(deadline)
      init.signal?.removeEventListener('abort', abortFromCaller)
    }
    if (deadlineMs !== undefined) {
      deadline = setTimeout(() => {
        const error = fail(new GuardedFetchError('TIMEOUT', 'request exceeded its deadline', { phase: 'deadline' }))
        exchange.abort(error)
        delivered?.destroy(error)
      }, deadlineMs)
      deadline.unref?.()
    }
    try {
      const response = await exchangeOnce(rawUrl, init, maxBytes, timeoutMs, exchange)
      delivered = response.body
      delivered.once('close', settle)
      return response
    } catch (error) {
      settle()
      throw error
    }
  }

  /** Races one hop's transport call against the header timer. */
  async function hopWithin(
    call: (signal: AbortSignal) => ReturnType<GuardedTransport>,
    timeoutMs: number,
    exchange: AbortController,
  ): Promise<Awaited<ReturnType<GuardedTransport>>> {
    const hop = new AbortController()
    const forward = (): void => hop.abort(exchange.signal.reason)
    if (exchange.signal.aborted) hop.abort(exchange.signal.reason)
    else exchange.signal.addEventListener('abort', forward, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = fail(new GuardedFetchError('TIMEOUT', 'request timed out', { phase: 'headers' }))
        hop.abort(error)
        reject(error)
      }, timeoutMs)
      // Also rejects for a transport that ignores its signal.
      hop.signal.addEventListener('abort', () => reject(hop.signal.reason ?? new Error('request aborted')), {
        once: true,
      })
    })
    expired.catch(() => undefined)
    const pending = call(hop.signal)
    try {
      // On success the forwarding stays: the caller's signal and the deadline
      // must still be able to end a body that is streaming.
      return await Promise.race([pending, expired])
    } catch (error) {
      exchange.signal.removeEventListener('abort', forward)
      // A response that arrives after we gave up is abandoned, not leaked.
      pending.then((late) => late.body.destroy(), () => undefined)
      throw translate(error)
    } finally {
      clearTimeout(timer)
    }
  }

  async function exchangeOnce(
    rawUrl: string,
    init: GuardedRequestInit,
    maxBytes: number,
    timeoutMs: number,
    exchange: AbortController,
  ): Promise<GuardedResponse> {
    let target = rawUrl
    let method = init.method ?? 'GET'
    let body = init.body
    // Mutable: a redirect to another host must not carry the caller's credentials.
    let headers: Record<string, string> = { ...init.headers }

    for (let hop = 0; ; hop++) {
      const url = parseTarget(target, fail)
      if (options.allowedHosts !== undefined && !hostAllowed(url.hostname, options.allowedHosts)) {
        throw fail(
          new GuardedFetchError('SSRF_BLOCKED', `Host "${url.hostname}" is not on the allowed-hosts list.`, {
            host: url.hostname,
            reason: 'it is not on its allowed-hosts list',
          }),
        )
      }
      // Re-raised carrying the HOST only: `resolveAndValidate` quotes the URL,
      // which here is routinely a pre-signed credential. No `cause`, on purpose.
      let validated: Awaited<ReturnType<typeof resolveAndValidate>>
      try {
        validated = await resolveAndValidate(target, {
          allowedSchemes: [...schemes],
          ...(options.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
          ...(options.lookup ? { lookup: options.lookup } : {}),
        })
      } catch {
        throw fail(
          new GuardedFetchError('SSRF_BLOCKED', `Host "${url.hostname}" failed address validation.`, {
            host: url.hostname,
            reason: 'the address failed validation',
          }),
        )
      }

      const hopBody = body
      const hopMethod = method
      const hopHeaders = headers
      const response = await hopWithin(
        (signal) =>
          transport(
            validated.url,
            {
              method: hopMethod,
              // Deliberately no accept-encoding: a body we never inflate cannot
              // be a decompression bomb.
              headers: { ...options.defaultHeaders, ...hopHeaders },
              ...(hopBody !== undefined ? { body: hopBody } : {}),
              signal,
              timeoutMs,
            },
            validated.pinned,
          ),
        timeoutMs,
        exchange,
      )

      if (response.status >= 300 && response.status < 400 && response.headers['location'] !== undefined) {
        response.body.destroy()
        if (hop >= maxRedirects) {
          throw fail(
            new GuardedFetchError('TOO_MANY_REDIRECTS', `Too many redirects from host "${url.hostname}".`, {
              host: url.hostname,
              redirects: hop + 1,
            }),
          )
        }
        // A `Location` can itself be a pre-signed URL, so a malformed one is
        // refused without quoting it back.
        let next: URL
        try {
          next = new URL(response.headers['location'] as string, validated.url)
        } catch {
          throw fail(
            new GuardedFetchError('SSRF_BLOCKED', `Host "${url.hostname}" sent an unparseable redirect.`, {
              host: url.hostname,
              reason: 'the redirect target could not be parsed',
            }),
          )
        }
        if (next.host !== url.host) headers = stripCredentials(headers)
        target = next.toString()
        // A redirected non-GET is replayed as GET without a body; a streamed
        // body cannot be replayed at all, so it is destroyed.
        method = 'GET'
        if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) body.destroy()
        body = undefined
        continue
      }

      const capped = capWith(response.body, maxBytes, tooLarge(maxBytes), (error) => translate(error) as Error)
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
        async arrayBuffer() {
          const bytes = await read()
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        },
        destroy() {
          capped.destroy()
        },
      }
    }
  }
}

/**
 * Parses a target without letting the URL escape into the failure: Node's
 * `ERR_INVALID_URL` carries the input on `error.input`.
 */
function parseTarget(target: string, fail: (error: GuardedFetchError) => Error): URL {
  try {
    return new URL(target)
  } catch {
    throw fail(
      new GuardedFetchError('SSRF_BLOCKED', 'The URL could not be parsed.', {
        host: '(unparseable url)',
        reason: 'the url could not be parsed',
      }),
    )
  }
}

/** Headers that must not survive a redirect to another host (case-insensitive). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization'])

function stripCredentials(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) kept[key] = value
  }
  return kept
}

/**
 * The production transport: node's http/https client with the agent `lookup`
 * pinned to the validated IP. `Host` and TLS SNI still carry the real
 * hostname. Unlike {@link pinnedRequest}, the response stream is handed back —
 * the byte cap, not immediate destruction, is what bounds it.
 */
export const pinnedStreamTransport: GuardedTransport = (url, init, pinned) =>
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
    // Inactivity timeout on the socket: a peer that accepts and then trickles
    // must not pin a worker for ever.
    request.setTimeout(init.timeoutMs, () =>
      request.destroy(new GuardedFetchError('TIMEOUT', 'request timed out', { phase: 'socket' })),
    )
    request.on('error', reject)
    const body = init.body
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      // Streamed upload: piped, never buffered; a failing source takes the
      // request down rather than sending a truncated body.
      body.on('error', (error) => request.destroy(error))
      body.pipe(request)
      return
    }
    if (body !== undefined) request.write(body)
    request.end()
  })
