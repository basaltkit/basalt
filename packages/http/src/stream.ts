/**
 * Adapter-agnostic streaming responses. A handler returns
 * `stream(source, { contentType, … })`; each adapter sends the bytes against
 * its own transport without buffering them (Fastify `reply.send(stream)`,
 * Express `pipeline()`, a `Response` over a web stream on Hono).
 *
 * Same idiom as {@link sse}: the helper returns an inert marker object, the
 * pipeline hands it back to the adapter untouched, and the adapter renders it.
 */
import { Readable } from 'node:stream'
import { sanitizeFilename } from './multipart.js'

/** What a streaming response may be built from. */
export type StreamSource = Readable | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

export interface StreamOptions {
  /** Response media type. Default `application/octet-stream`. */
  contentType?: string
  /**
   * Exact body size in bytes, when it is known (a stored file's size). Sent as
   * `Content-Length` so clients can show progress; omit it and the response is
   * chunked. Never guess: a wrong value truncates or hangs the download.
   */
  contentLength?: number
  /**
   * Download filename. Sent as `Content-Disposition`, sanitised
   * ({@link sanitizeFilename}) and encoded per RFC 5987 — a client-supplied
   * name can carry no CR/LF, quotes or path separators into the header.
   */
  filename?: string
  /**
   * How the browser should treat the body. Default `attachment` — an uploaded
   * HTML/SVG file must never render on your origin. Only set `inline` when
   * rendering it is deliberate. Ignored unless `filename` is given.
   */
  disposition?: 'attachment' | 'inline'
  /** Extra response headers (CR/LF stripped from every value). */
  headers?: Record<string, string>
  /** Response status. Default `200`. */
  status?: number
}

/** What the adapter needs to send a {@link stream} response. */
export interface StreamPayload {
  source: StreamSource
  status: number
  /** Lower-cased header names, ready to write. */
  headers: Record<string, string>
}

const STREAM = Symbol.for('basalt.stream')

export interface StreamResponse {
  readonly [STREAM]: StreamPayload
}

/**
 * Wrap a byte source as a streaming response for a route handler to return.
 *
 * ```ts
 * const { record, stream: body } = await files.downloadStream(id)
 * return stream(body, { contentType: record.contentType, contentLength: record.size, filename: record.name })
 * ```
 *
 * The bytes are never collected in memory: a slow client slows the source
 * (real backpressure), and a client that disconnects destroys it, so no file
 * descriptor or backend socket is leaked.
 */
export function stream(source: StreamSource, options: StreamOptions = {}): StreamResponse {
  return { [STREAM]: { source, status: options.status ?? 200, headers: streamHeaders(options) } }
}

export function isStreamResponse(value: unknown): value is StreamResponse {
  return typeof value === 'object' && value !== null && STREAM in (value as object)
}

export function streamPayloadOf(value: StreamResponse): StreamPayload {
  return value[STREAM]
}

/** A header value can never carry CR/LF/NUL — that would split the response. */
// eslint-disable-next-line no-control-regex
const HEADER_UNSAFE = /[\r\n\u0000]/g

function streamHeaders(options: StreamOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined || value === null) continue
    headers[name.toLowerCase()] = String(value).replace(HEADER_UNSAFE, '')
  }
  headers['content-type'] = (options.contentType ?? 'application/octet-stream').replace(HEADER_UNSAFE, '')
  const length = options.contentLength
  if (length !== undefined && Number.isSafeInteger(length) && length >= 0) {
    headers['content-length'] = String(length)
  }
  if (options.filename !== undefined) {
    headers['content-disposition'] = contentDisposition(options.filename, options.disposition)
  }
  return headers
}

/** RFC 5987 `attr-char` excludes these, which `encodeURIComponent` leaves alone. */
const NOT_ATTR_CHAR = /['()*]/g

/**
 * A `Content-Disposition` value for a client-supplied filename: the name goes
 * through {@link sanitizeFilename} (no directories, control characters or bidi
 * overrides), the plain `filename=` parameter keeps only printable ASCII with
 * quotes and backslashes replaced, and anything lost that way is carried by an
 * RFC 5987 `filename*=UTF-8''…` parameter.
 */
export function contentDisposition(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const type = disposition === 'inline' ? 'inline' : 'attachment'
  const name = sanitizeFilename(filename)
  // eslint-disable-next-line no-control-regex
  const ascii = name.replace(/["\\]/g, '_').replace(/[^\u0020-\u007E]/g, '_')
  const value = `${type}; filename="${ascii}"`
  if (ascii === name) return value
  const encoded = encodeURIComponent(name).replace(
    NOT_ATTR_CHAR,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${value}; filename*=UTF-8''${encoded}`
}

const isNodeReadable = (value: unknown): value is Readable =>
  value instanceof Readable ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as Readable).pipe === 'function' &&
    typeof (value as Readable).destroy === 'function')

const isWebStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof value === 'object' && value !== null && typeof (value as ReadableStream).getReader === 'function'

/**
 * The source as a Node `Readable`, for the adapters whose transport is a Node
 * response. Destroying the returned stream releases the original source: a web
 * stream is cancelled, an async iterable gets its `return()`.
 */
export function toNodeStream(source: StreamSource): Readable {
  if (isNodeReadable(source)) return source
  if (isWebStream(source)) return Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0])
  // Byte mode, not `Readable.from`'s object-mode default: backpressure must be
  // counted in bytes, not in "16 chunks of whatever size".
  return Readable.from(source, { objectMode: false, highWaterMark: 64 * 1024 })
}

/**
 * Releases a source nobody will read — a `HEAD` request, or a response the
 * adapter is about to abandon. Never throws.
 */
export function destroyStreamSource(source: StreamSource, error?: Error): void {
  try {
    if (isNodeReadable(source)) {
      source.destroy(error)
      return
    }
    if (isWebStream(source)) {
      void source.cancel().catch(() => undefined)
      return
    }
    void (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      .return?.()
      .catch(() => undefined)
  } catch {
    /* a source that cannot be released is not worth failing the response over */
  }
}

/**
 * A pull reader over any {@link StreamSource}: one chunk at a time, with an
 * explicit `close()`. Used by the adapters whose transport is a web
 * `ReadableStream`, where pulling on demand is what makes backpressure real.
 */
export interface StreamPump {
  /** The next chunk, or `null` at the end of the source. */
  next(): Promise<Uint8Array | null>
  /** Releases the source (destroy/cancel/`return`). Idempotent, never throws. */
  close(error?: Error): Promise<void>
  readonly closed: boolean
}

const asBytes = (chunk: Uint8Array | string): Uint8Array =>
  typeof chunk === 'string' ? Buffer.from(chunk) : chunk

export function streamPump(source: StreamSource): StreamPump {
  let closed = false
  if (isWebStream(source)) {
    const reader = source.getReader()
    return {
      get closed() {
        return closed
      },
      async next() {
        const { done, value } = await reader.read()
        return done ? null : value
      },
      async close() {
        if (closed) return
        closed = true
        await reader.cancel().catch(() => undefined)
        try {
          reader.releaseLock()
        } catch {
          /* a read is still pending — the runtime reclaims it */
        }
      },
    }
  }
  const iterator = (source as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]()
  return {
    get closed() {
      return closed
    },
    async next() {
      const result = await iterator.next()
      return result.done === true ? null : asBytes(result.value)
    },
    async close(error) {
      if (closed) return
      closed = true
      // A Node Readable is destroyed outright, so its file descriptor or
      // backend socket goes now rather than whenever the iterator is collected.
      if (isNodeReadable(source)) source.destroy(error)
      await iterator.return?.().catch(() => undefined)
    },
  }
}

/**
 * Pulls the first chunk before any header is flushed, so a source that fails
 * immediately (a deleted object, a refused S3 request) can still become a
 * normal JSON error response instead of a truncated body. The source is
 * released before the failure is rethrown.
 */
export async function openStreamPump(source: StreamSource): Promise<{ pump: StreamPump; first: Uint8Array | null }> {
  const pump = streamPump(source)
  try {
    return { pump, first: await pump.next() }
  } catch (error) {
    await pump.close()
    throw error
  }
}

/**
 * A Node `Readable` over a pump whose first chunk has already been pulled.
 * Destroying it (the client disconnected, the response was torn down) closes
 * the pump, which destroys the original source.
 */
export function nodeStreamFrom(pump: StreamPump, first: Uint8Array | null): Readable {
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      if (first !== null) yield first
      for (;;) {
        const chunk = await pump.next()
        if (chunk === null) return
        yield chunk
      }
    } finally {
      await pump.close()
    }
  }
  const readable = Readable.from(body(), { objectMode: false, highWaterMark: 64 * 1024 })
  // `Readable.from` releases the generator with `return()`, which does nothing
  // when the generator has not started — a stream destroyed before its first
  // read would leak the source. `close` fires on every ending, and `pump.close`
  // is idempotent, so this covers that case without double-closing.
  readable.on('close', () => void pump.close())
  return readable
}

/**
 * A web `ReadableStream` over a pump whose first chunk has already been pulled.
 * `pull` runs only when the consumer has room, so a slow client slows the
 * source; `cancel` (the client disconnecting) closes it.
 */
export function webStreamFrom(
  pump: StreamPump,
  first: Uint8Array | null,
  onError?: (error: unknown) => void,
): ReadableStream<Uint8Array> {
  let pending: Uint8Array | null = first
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending !== null) {
        const chunk = pending
        pending = null
        controller.enqueue(chunk)
        return
      }
      try {
        const chunk = await pump.next()
        if (chunk === null) {
          await pump.close()
          controller.close()
          return
        }
        controller.enqueue(chunk)
      } catch (error) {
        // Headers are long gone: the only honest end is a broken body, never
        // an error payload appended to the bytes already sent.
        onError?.(error)
        await pump.close()
        controller.error(error)
      }
    },
    async cancel() {
      await pump.close()
    },
  })
}
