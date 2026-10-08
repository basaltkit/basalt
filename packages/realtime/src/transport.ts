import { randomUUID } from 'node:crypto'
import type { Connection, RealtimeHub, RealtimeMessage } from './hub.js'

/**
 * Formats a message as a Server-Sent Events frame. CR, LF and NUL are stripped
 * from the event name: SSE splits fields on every line terminator, so an event
 * name carrying one would end the `event:` field early and let its remainder
 * forge extra fields or whole frames (FA-065). `data` needs no such care — JSON
 * escapes every line terminator.
 */
export function sseFrame(message: RealtimeMessage): string {
  const data = JSON.stringify({ channel: message.channel, data: message.data })
  const event = String(message.event).replace(/[\r\n\u0000]/g, '')
  return `event: ${event}\ndata: ${data}\n\n`
}

export interface ConnectionMeta {
  tenantId: string
  userId?: string
  id?: string
}

/**
 * Builds an SSE {@link Connection}. The caller supplies how to write to and end
 * the response (adapter-specific: fastify `reply.raw`, express `res`, a Hono
 * stream), keeping this helper framework-neutral.
 */
export function sseConnection(meta: ConnectionMeta, io: { write(chunk: string): void; end(): void }): Connection {
  return {
    id: meta.id ?? randomUUID(),
    tenantId: meta.tenantId,
    ...(meta.userId !== undefined ? { userId: meta.userId } : {}),
    send: (message) => io.write(sseFrame(message)),
    close: () => io.end(),
  }
}

/**
 * The stream `@basaltkit/http`'s `sse()` hands its producer — declared
 * structurally so this package never depends on the HTTP layer. `send` frames
 * the event itself and returns `false` when the stream is closed or the
 * transport's buffer is full.
 */
export interface SseStreamLike {
  send(event: { event?: string; data: unknown; id?: string } | string): boolean
  close(): void
  onClose(listener: () => void): void
  readonly closed: boolean
}

export interface SseStreamConnectionOptions {
  /**
   * Consecutive sends that hit a full buffer (`send` returned `false` on an
   * open stream) before the stream is closed — a client too slow to keep up
   * would otherwise grow the server's memory without bound. A send that goes
   * through resets the count. Default 50.
   */
  maxBackpressure?: number
}

/**
 * Builds a {@link Connection} over an `sse()` stream. Frames carry the same
 * wire shape as {@link sseConnection} — `event: <event>` with
 * `data: { channel, data }` — so `@basaltkit/realtime-client` reads both alike.
 *
 * `send` throws only once the stream is closed, which is the hub's signal to
 * prune the connection. Backpressure never throws (a throw would prune a
 * merely slow client); it is counted, and the stream is closed after
 * `maxBackpressure` consecutive pressured sends.
 */
export function sseStreamConnection(
  meta: ConnectionMeta,
  stream: SseStreamLike,
  options: SseStreamConnectionOptions = {},
): Connection {
  const maxBackpressure = options.maxBackpressure ?? 50
  let pressured = 0
  return {
    id: meta.id ?? randomUUID(),
    tenantId: meta.tenantId,
    ...(meta.userId !== undefined ? { userId: meta.userId } : {}),
    send: (message) => {
      if (stream.closed) throw new Error('SSE stream is closed.')
      if (stream.send({ event: message.event, data: { channel: message.channel, data: message.data } })) {
        pressured = 0
        return
      }
      if (stream.closed) throw new Error('SSE stream is closed.')
      if (++pressured >= maxBackpressure) stream.close()
    },
    close: () => stream.close(),
  }
}

export interface RealtimeSseOptions extends SseStreamConnectionOptions {
  /** Who the stream belongs to — take it from the request context, never from the client. */
  meta: ConnectionMeta
  /** Channels to join. Each goes through the hub's `authorize`; one refusal closes the stream. */
  channels: readonly string[]
  /** Runs once every channel is joined — e.g. to send a snapshot. */
  onOpen?: (connection: Connection) => void | Promise<void>
}

/**
 * The producer for `@basaltkit/http`'s `sse()`: registers a connection on the
 * hub, joins `channels`, and unregisters it when the client goes away — on
 * every adapter, with no access to the raw response.
 *
 * ```ts
 * route({
 *   method: 'GET', url: '/live', meta: { auth: true },
 *   handler: () => sse(realtimeSse(hub, {
 *     meta: { tenantId: ctx().tenant.id, userId: ctx().user.id },
 *     channels: ['notes'],
 *   }), { heartbeatMs: 15_000 }),
 * })
 * ```
 *
 * A channel the hub refuses (`authorize`, caps) closes the stream: check
 * access in the handler first if the client should get a 403 instead.
 */
export function realtimeSse(
  hub: RealtimeHub,
  options: RealtimeSseOptions,
): (stream: SseStreamLike) => Promise<void> {
  return async (stream) => {
    const connection = sseStreamConnection(
      options.meta,
      stream,
      options.maxBackpressure !== undefined ? { maxBackpressure: options.maxBackpressure } : {},
    )
    // Wait for the client to go away: sse() ends the response as soon as the
    // producer returns. Registered first, so a disconnect during the
    // subscriptions below still unregisters.
    let done: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      done = resolve
    })
    stream.onClose(() => {
      hub.unregister(connection.id)
      done()
    })
    // A structural stream may not replay `onClose` to a listener added after
    // it closed (http's does); never wait forever on one that already has.
    if (stream.closed) done()
    if (!stream.closed) {
      hub.register(connection)
      for (const channel of options.channels) {
        if (stream.closed) break
        if (!(await hub.subscribe(connection.id, channel))) {
          stream.close()
          break
        }
      }
      if (!stream.closed) await options.onOpen?.(connection)
    }
    await closed
  }
}

/** The minimal WebSocket surface used — any `ws`-style socket satisfies it. */
export interface WebSocketLike {
  send(data: string): void
  close(): void
}

/** Builds a WebSocket {@link Connection} from any `ws`-style socket. */
export function websocketConnection(meta: ConnectionMeta, socket: WebSocketLike): Connection {
  return {
    id: meta.id ?? randomUUID(),
    tenantId: meta.tenantId,
    ...(meta.userId !== undefined ? { userId: meta.userId } : {}),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  }
}
