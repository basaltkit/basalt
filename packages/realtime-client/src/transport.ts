/** A message pushed from the server to a channel. */
export interface RealtimeMessage {
  channel: string
  event: string
  data: unknown
}

/** A control message the client sends upstream (WebSocket only). */
export interface ClientCommand {
  type: 'subscribe' | 'unsubscribe'
  channel: string
}

/** Callbacks a transport drives as its underlying socket changes state. */
export interface TransportHandlers {
  onOpen(): void
  onMessage(message: RealtimeMessage): void
  onClose(): void
  onError(error: unknown): void
}

/** A connection mechanism (WebSocket or SSE) the client sits on top of. */
export interface Transport {
  connect(handlers: TransportHandlers): void
  send(command: ClientCommand): void
  close(): void
  /** SSE needs the event names to listen for; WebSocket ignores this. */
  track?(event: string): void
}

// --- injectable socket shapes (so tests need no browser globals) ------------

export interface WebSocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: ((error: unknown) => void) | null
}
export type WebSocketCtor = new (url: string) => WebSocketLike

export interface EventSourceLike {
  close(): void
  addEventListener(type: string, listener: (event: { data: string }) => void): void
  onopen: (() => void) | null
  onerror: ((error: unknown) => void) | null
}
export type EventSourceCtor = new (url: string) => EventSourceLike

/** WebSocket transport — bidirectional; can send subscribe/unsubscribe. */
export class WebSocketTransport implements Transport {
  private socket: WebSocketLike | undefined
  constructor(
    private readonly url: string,
    private readonly Ctor: WebSocketCtor,
  ) {}

  connect(handlers: TransportHandlers): void {
    const socket = new this.Ctor(this.url)
    this.socket = socket
    socket.onopen = () => handlers.onOpen()
    socket.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(event.data) as RealtimeMessage)
      } catch (error) {
        handlers.onError(error)
      }
    }
    socket.onclose = () => handlers.onClose()
    socket.onerror = (error) => handlers.onError(error)
  }

  send(command: ClientCommand): void {
    this.socket?.send(JSON.stringify(command))
  }

  close(): void {
    this.socket?.close()
  }
}

/** SSE transport — receive-only; subscriptions are carried by the URL/auth. */
export class SseTransport implements Transport {
  private source: EventSourceLike | undefined
  private handlers: TransportHandlers | undefined
  private readonly tracked = new Set<string>()

  constructor(
    private readonly url: string,
    private readonly Ctor: EventSourceCtor,
  ) {}

  connect(handlers: TransportHandlers): void {
    this.handlers = handlers
    const source = new this.Ctor(this.url)
    this.source = source
    source.onopen = () => handlers.onOpen()
    source.onerror = (error) => {
      handlers.onError(error)
      handlers.onClose()
    }
    for (const event of this.tracked) this.listen(event)
  }

  send(): void {
    // SSE is one-way; the server subscribes based on the URL/authenticated user.
  }

  track(event: string): void {
    if (this.tracked.has(event)) return
    this.tracked.add(event)
    if (this.source) this.listen(event)
  }

  close(): void {
    this.source?.close()
  }

  private listen(event: string): void {
    this.source!.addEventListener(event, (raw) => {
      try {
        const { channel, data } = JSON.parse(raw.data) as { channel: string; data: unknown }
        this.handlers?.onMessage({ channel, event, data })
      } catch (error) {
        this.handlers?.onError(error)
      }
    })
  }
}
