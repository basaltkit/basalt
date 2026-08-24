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
  /** Send an event (or a bare data string). No-op once closed. */
  send(event: SseEvent | string): void
  /** End the stream. */
  close(): void
  readonly closed: boolean
  /** Run a listener when the client disconnects or the stream closes. */
  onClose(listener: () => void): void
}

export type SseProducer = (stream: SseStream) => void | Promise<void>

const SSE = Symbol.for('basalt.sse')

export interface SseResponse {
  readonly [SSE]: SseProducer
}

/** Wrap a producer as an SSE response for a route handler to return. */
export function sse(producer: SseProducer): SseResponse {
  return { [SSE]: producer }
}

export function isSseResponse(value: unknown): value is SseResponse {
  return typeof value === 'object' && value !== null && SSE in (value as object)
}

export function sseProducerOf(value: SseResponse): SseProducer {
  return value[SSE]
}

/** Encode one event into the `text/event-stream` wire format. */
export function encodeSseEvent(event: SseEvent | string): string {
  if (typeof event === 'string') return `data: ${event}\n\n`
  const lines: string[] = []
  if (event.event) lines.push(`event: ${event.event}`)
  if (event.id) lines.push(`id: ${event.id}`)
  if (event.retry !== undefined) lines.push(`retry: ${Math.round(event.retry)}`)
  const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
  for (const line of String(data).split('\n')) lines.push(`data: ${line}`)
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
  write(frame: string): void
  end(): void
  onClose(listener: () => void): void
}

/**
 * Drive a producer against a sink: exposes an `SseStream` to the producer,
 * relays client disconnects, and ends the sink when the producer finishes.
 * Shared by every adapter so behaviour is identical.
 */
export async function driveSse(producer: SseProducer, sink: SseSink): Promise<void> {
  let closed = false
  const listeners: Array<() => void> = []
  const markClosed = () => {
    if (closed) return
    closed = true
    for (const listener of listeners) listener()
  }
  sink.onClose(markClosed)

  const stream: SseStream = {
    send(event) {
      if (!closed) sink.write(encodeSseEvent(event))
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

  try {
    await producer(stream)
  } finally {
    if (!closed) {
      markClosed()
      sink.end()
    }
  }
}
