import { randomUUID } from 'node:crypto'
import type { Connection, RealtimeMessage } from './hub.js'

/** Formats a message as a Server-Sent Events frame. */
export function sseFrame(message: RealtimeMessage): string {
  const data = JSON.stringify({ channel: message.channel, data: message.data })
  return `event: ${message.event}\ndata: ${data}\n\n`
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
