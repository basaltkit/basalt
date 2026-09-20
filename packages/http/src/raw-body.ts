import type { Readable } from 'node:stream'
import { z, type ZodType } from 'zod'
import { HttpError } from './errors.js'
import type { BasaltRoute, HttpReply, HttpRequest } from './route.js'

/**
 * Default cap on a {@link rawBody} body: 1 MiB.
 *
 * Deliberately small. Every payload this marker exists for — a Stripe,
 * Paddle, Lemon Squeezy, Dropbox, Microsoft Graph or GitHub webhook — is
 * measured in kilobytes, and the endpoint receiving it is unauthenticated by
 * construction (the signature IS the authentication, and it can only be
 * checked once the bytes are in memory). The cap is what stops such an
 * endpoint from being a memory amplifier.
 */
export const DEFAULT_RAW_BODY_MAX_BYTES = 1024 * 1024

/** Limits for a {@link rawBody} route body. */
export interface RawBodyOptions {
  /**
   * Most bytes the body may carry. Over it: 413 `PAYLOAD_TOO_LARGE`, refused
   * on the declared `Content-Length` when there is one and on the bytes
   * actually received when there is not. Default {@link DEFAULT_RAW_BODY_MAX_BYTES}.
   */
  maxBytes?: number
}

/** What a `rawBody()` route's handler receives as `body`. */
export interface RawBody {
  /**
   * The exact bytes that arrived — never parsed, never re-serialised. This is
   * the message a provider signed; anything derived from a parsed object is a
   * different message.
   */
  bytes: Buffer
  /**
   * The declared `Content-Type` essence, lower-cased and without parameters
   * (`application/json`), or `undefined` when the client sent none. The
   * client's claim about the bytes, not a fact about them.
   */
  contentType: string | undefined
  /** The declared `Content-Length`, when the client sent one. */
  contentLength: number | undefined
  /**
   * `bytes` decoded as UTF-8 — the form most signature schemes are specified
   * against (`stripe.webhooks.constructEvent` takes a string). Decoding is
   * lossy for bytes that are not valid UTF-8; use {@link RawBody.bytes} when
   * the scheme is specified over octets.
   */
  text(): string
}

/** The resolved limits behind a {@link rawBody} marker. */
export interface ResolvedRawBodyOptions {
  maxBytes: number
}

const RAW_BODIES = new WeakMap<object, ResolvedRawBodyOptions>()

/**
 * Declares that a route wants the **untouched request bytes** — adapter-neutral:
 * the same route sees byte-identical input on Fastify, Express and Hono.
 *
 * ```ts
 * route({
 *   method: 'POST', url: '/webhooks/stripe',
 *   body: rawBody({ maxBytes: 64 * 1024 }),
 *   handler({ body, request }) {
 *     const event = stripe.webhooks.constructEvent(
 *       body.text(),
 *       request.headers['stripe-signature'] as string,
 *       secret,
 *     )
 *   },
 * })
 * ```
 *
 * Why this has to exist: every adapter parses `application/json` before a
 * handler runs, and a signature covers the bytes that arrived. `JSON.stringify`
 * of the parsed object is not an approximation of those bytes — key order,
 * whitespace, number formatting and escaping all differ — so a route that
 * verified against it would reject every genuine delivery (or, if it shrugged
 * the mismatch off, accept every forgery).
 *
 * The usual pipeline order is preserved: pre-hooks (rate limiting), enrichers
 * (tenant, user) and guards (auth, permissions) all run BEFORE a single body
 * byte is read, exactly as for {@link upload}. A body the route never gets to
 * read — a guard rejected first — is drained and the connection closed, so
 * nothing hangs. The bytes are never handed to a parser, this package's or the
 * app's.
 */
export function rawBody(options: RawBodyOptions = {}): ZodType<RawBody> {
  const maxBytes = options.maxBytes ?? DEFAULT_RAW_BODY_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('rawBody(): `maxBytes` must be a positive integer.')
  }
  const schema = z.custom<RawBody>(
    (value) => typeof value === 'object' && value !== null && Buffer.isBuffer((value as RawBody).bytes),
  )
  RAW_BODIES.set(schema, { maxBytes })
  return schema
}

/** The resolved limits when `schema` came from {@link rawBody}; otherwise `undefined`. */
export function rawBodyOptionsOf(schema: unknown): ResolvedRawBodyOptions | undefined {
  return typeof schema === 'object' && schema !== null ? RAW_BODIES.get(schema) : undefined
}

/** True when a route's `body` is a {@link rawBody} declaration — adapters skip their own body parsing for it. */
export const isRawBody = (schema: unknown): boolean => rawBodyOptionsOf(schema) !== undefined

/**
 * A predicate telling whether an inbound `method` + path belongs to one of
 * these routes' {@link rawBody} declarations.
 *
 * Adapters that parse bodies in middleware — before a route is matched — need
 * this to step aside for exactly those paths (Express's `express.json({ type })`,
 * the Hono plugin's bounded-read middleware). Path parameters (`:id`) match one
 * segment; a `*` segment matches one segment and a trailing `/*` matches the
 * rest. Anything else is compared literally, so an unrecognised pattern
 * under-matches rather than over-matches — the adapter then falls back to its
 * own capture instead of silently leaving a JSON route unparsed.
 */
export function rawBodyRouteMatcher(routes: readonly BasaltRoute[]): (method: string, path: string) => boolean {
  const patterns = routes
    .filter((definition) => isRawBody(definition.body))
    .map((definition) => ({ method: definition.method.toUpperCase(), test: patternToRegExp(definition.url) }))
  if (patterns.length === 0) return () => false
  return (method, path) => {
    const wanted = method.toUpperCase()
    const clean = pathOnly(path)
    return patterns.some((pattern) => pattern.method === wanted && pattern.test.test(clean))
  }
}

const pathOnly = (url: string): string => {
  const cut = url.indexOf('?')
  const path = cut < 0 ? url : url.slice(0, cut)
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function patternToRegExp(url: string): RegExp {
  const segments = pathOnly(url).split('/')
  const source = segments
    .map((segment, index) => {
      if (segment === '') return ''
      if (segment.startsWith(':')) return '[^/]+'
      if (segment === '*') return index === segments.length - 1 ? '.*' : '[^/]+'
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${source}$`)
}

const tooLarge = (): HttpError =>
  new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.')

/**
 * The bytes could not be obtained on this adapter — a server misconfiguration,
 * never the client's fault, and never something to paper over: a route that
 * guessed here would verify a signature against a message nobody sent.
 */
const unavailable = (): HttpError =>
  new HttpError(
    500,
    'RAW_BODY_UNAVAILABLE',
    'The raw request body was not available: another body parser consumed it before the route ran. ' +
      'See the adapter notes for `rawBody()` in the @basaltkit/http README.',
  )

/** No bytes — what a request that declared no body carries. */
const EMPTY = Buffer.alloc(0)

const malformed = (): HttpError =>
  new HttpError(400, 'BAD_REQUEST', 'Request body ended unexpectedly.')

const headerOf = (request: HttpRequest, name: string): string | undefined => {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** The media type without parameters, lower-cased. */
const essence = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const cut = value.indexOf(';')
  const type = (cut < 0 ? value : value.slice(0, cut)).trim().toLowerCase()
  return type === '' ? undefined : type
}

const declaredLength = (request: HttpRequest): number | undefined => {
  const value = headerOf(request, 'content-length')
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
}

const isWebStream = (source: unknown): source is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== 'undefined' && source instanceof ReadableStream

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  const view = chunk as Uint8Array
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

/**
 * Reads a body to the end with a hard cap on the bytes ACTUALLY received — a
 * `Content-Length` header alone is not a limit (a chunked body carries none).
 */
async function readAll(source: Readable | ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let received = 0
  const push = (chunk: unknown): void => {
    const buffer = toBuffer(chunk)
    received += buffer.length
    if (received > maxBytes) throw tooLarge()
    chunks.push(buffer)
  }
  if (isWebStream(source)) {
    const reader = source.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        push(value)
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* a read is still pending — the runtime reclaims the body with the request */
      }
    }
  } else {
    try {
      for await (const chunk of source) push(chunk)
    } catch (error) {
      // A HttpError raised by `push` is the verdict; anything else means the
      // client went away mid-body, which is a 400, not a 500.
      throw error instanceof HttpError ? error : malformed()
    }
  }
  return Buffer.concat(chunks, received)
}

/** Discards a body the route will never read, so the connection cannot hang on it. */
async function drain(source: Readable | ReadableStream<Uint8Array>, cap: number): Promise<void> {
  try {
    await readAll(source, cap)
  } catch {
    /* over the cap, or the client went away — nothing left to drain */
  }
}

/**
 * One request's raw body: reads it once, only when the pipeline asks (after
 * enrichers and guards), and releases whatever is left otherwise. Created by
 * the pipeline; not public API.
 */
export class RawBodySession {
  private settled = false

  constructor(
    private readonly request: HttpRequest,
    readonly options: ResolvedRawBodyOptions,
  ) {}

  /** The handler's `body`. Throws 413 over the cap, 500 when no adapter supplied bytes. */
  async read(): Promise<RawBody> {
    this.settled = true
    const contentType = essence(headerOf(this.request, 'content-type'))
    const contentLength = declaredLength(this.request)
    if (contentLength !== undefined && contentLength > this.options.maxBytes) throw tooLarge()
    const bytes = await this.collect()
    let text: string | undefined
    return {
      bytes,
      contentType,
      contentLength,
      text: () => (text ??= bytes.toString('utf8')),
    }
  }

  /**
   * Called once the route is done. A body nobody read (a guard rejected first)
   * gets `Connection: close` and is drained up to the cap — the request can
   * never hang on an unread body.
   */
  release(reply: HttpReply): void {
    if (this.settled) return
    this.settled = true
    if (!reply.sent) {
      try {
        reply.header('connection', 'close')
      } catch {
        /* headers already flushed */
      }
    }
    const source = this.request.bodyStream
    if (source) void drain(source, this.options.maxBytes)
  }

  private async collect(): Promise<Buffer> {
    // An adapter that could not leave the body unread hands the bytes it kept.
    const kept = this.request.bodyBytes
    if (kept !== undefined) {
      const buffer = toBuffer(kept)
      if (buffer.length > this.options.maxBytes) throw tooLarge()
      return buffer
    }
    const source = this.request.bodyStream
    if (source !== undefined) return readAll(source, this.options.maxBytes)
    // No source at all. Whether that is a problem depends on whether the
    // request said it was sending anything: a POST that declared no body has
    // an EMPTY body, which is a fact about the request rather than a guess
    // about a message — and it is the shape several providers validate a
    // webhook URL with (Microsoft Graph posts `?validationToken=` with no body
    // at all, before the subscription it would sign for exists). Refusing
    // those would report a body-parser problem as a subscription failure.
    // A request that DID declare bytes and cannot produce them is the real
    // failure, and still fails closed.
    if (!this.declaresBody()) return EMPTY
    throw unavailable()
  }

  /** Whether the request's own framing says it is sending bytes. */
  private declaresBody(): boolean {
    const length = declaredLength(this.request)
    if (length !== undefined) return length > 0
    // No Content-Length: only a chunked/encoded body can still carry bytes.
    return headerOf(this.request, 'transfer-encoding') !== undefined
  }
}
