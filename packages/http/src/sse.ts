/**
 * Typed Server-Sent Events, adapter-agnostic. A handler returns
 * `sse(async (stream) => { … })`; each adapter renders it against its own
 * transport (a Node response on Fastify/Express, a `ReadableStream` on Hono).
 * The producer drives the stream: `send()` an event, `close()` to end, and
 * `onClose()` to react to the client disconnecting.
 */

export interface SseEvent {
  /** Payload — objects are JSON-encoded, strings sent as-is (split across `data:` lines). */
  data: unknown
  /** SSE event name (the client's `addEventListener(name)`). */
  event?: string
  /** Event id (drives `Last-Event-ID` reconnection). */
  id?: string
  /** Client reconnection delay hint (ms). */
  retry?: number
}

export interface SseStream {
  /**
   * Send an event (or a bare data string). Returns `false` if the stream is
   * closed OR the transport's write buffer is full — a backpressure signal a
   * producer should honour (await/slow down) to avoid unbounded memory growth
   * with a slow client. No-op once closed.
   */
  send(event: SseEvent | string): boolean
  /** End the stream. */
  close(): void
  readonly closed: boolean
  /** Run a listener when the client disconnects or the stream closes. */
  onClose(listener: () => void): void
}

export type SseProducer = (stream: SseStream) => void | Promise<void>

const SSE = Symbol.for('basalt.sse')
const SSE_OPTS = Symbol.for('basalt.sse.options')

/** Edge-hardening knobs for a stream — defends against dead/idle connections. */
export interface SseOptions {
  /**
   * Send a comment ping every N ms. Keeps proxies from closing an idle stream
   * and surfaces a dead socket (the write fails) instead of leaking the
   * connection. Off when unset.
   */
  heartbeatMs?: number
  /**
   * Hard cap on a single stream's lifetime, in ms. The stream is closed when it
   * elapses — a backstop against connections that never disconnect. Off when unset.
   */
  maxDurationMs?: number
}

type ProducerWithOptions = SseProducer & { [SSE_OPTS]?: SseOptions }

export interface SseResponse {
  readonly [SSE]: SseProducer
}

/** Wrap a producer as an SSE response for a route handler to return. */
export function sse(producer: SseProducer, options: SseOptions = {}): SseResponse {
  const wrapped: ProducerWithOptions = (stream) => producer(stream)
  wrapped[SSE_OPTS] = options
  return { [SSE]: wrapped }
}

export function isSseResponse(value: unknown): value is SseResponse {
  return typeof value === 'object' && value !== null && SSE in (value as object)
}

export function sseProducerOf(value: SseResponse): SseProducer {
  return value[SSE]
}

/** Encode one event into the `text/event-stream` wire format. */
/**
 * Strip CR/LF/NUL from a single-line SSE field (`event`, `id`). Newlines there
 * would let a value inject additional SSE fields or whole events (event-stream
 * response splitting) — the spec forbids them, so we drop them defensively.
 */
function sseField(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\r\n\u0000]/g, '')
}

export function encodeSseEvent(event: SseEvent | string): string {
  const lines: string[] = []
  if (typeof event !== 'string') {
    if (event.event) lines.push(`event: ${sseField(event.event)}`)
    if (event.id) lines.push(`id: ${sseField(event.id)}`)
    if (event.retry !== undefined) lines.push(`retry: ${Math.round(event.retry)}`)
  }
  const payload = typeof event === 'string' ? event : event.data
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  // Split on every SSE line terminator (\r\n, \r, or \n) and re-prefix each line
  // with `data:` — a bare \r in the payload must not leak an unprefixed line.
  for (const line of String(data).split(/\r\n|\r|\n/)) lines.push(`data: ${line}`)
  return `${lines.join('\n')}\n\n`
}

/** Standard SSE response headers. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no', // disable proxy buffering (nginx)
}

/** A transport an adapter provides — where frames are written and how disconnects arrive. */
export interface SseSink {
  /**
   * Write a frame. Return `false` when the underlying buffer is full (Node's
   * `res.write` convention) so `send` can surface backpressure; returning
   * `void` is treated as "written, no pressure".
   */
  write(frame: string): boolean | void
  end(): void
  onClose(listener: () => void): void
}

/**
 * Drive a producer against a sink: exposes an `SseStream` to the producer,
 * relays client disconnects, and ends the sink when the producer finishes.
 * Shared by every adapter so behaviour is identical.
 */
export async function driveSse(producer: SseProducer, sink: SseSink): Promise<void> {
  const options = (producer as ProducerWithOptions)[SSE_OPTS] ?? {}
  let closed = false
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const listeners: Array<() => void> = []
  const markClosed = () => {
    if (closed) return
    closed = true
    for (const timer of timers) clearTimeout(timer)
    for (const listener of listeners) listener()
  }
  sink.onClose(markClosed)

  const stream: SseStream = {
    send(event) {
      if (closed) return false
      return sink.write(encodeSseEvent(event)) !== false
    },
    close() {
      if (!closed) {
        markClosed()
        sink.end()
      }
    },
    get closed() {
      return closed
    },
    onClose(listener) {
      if (closed) listener()
      else listeners.push(listener)
    },
  }

  // Heartbeat: a comment ping (`:\n\n`) keeps proxies alive and reveals a dead
  // socket. Uses an interval that unrefs so it never holds the process open.
  if (options.heartbeatMs && options.heartbeatMs > 0) {
    const beat = setInterval(() => {
      if (closed) return
      sink.write(': ping\n\n')
    }, options.heartbeatMs)
    beat.unref?.()
    timers.push(beat)
  }
  // Max lifetime: a backstop close for connections that never disconnect.
  if (options.maxDurationMs && options.maxDurationMs > 0) {
    const cap = setTimeout(() => {
      if (!closed) {
        markClosed()
        sink.end()
      }
    }, options.maxDurationMs)
    cap.unref?.()
    timers.push(cap)
  }

  try {
    await producer(stream)
  } finally {
    if (!closed) {
      markClosed()
      sink.end()
    }
  }
}
