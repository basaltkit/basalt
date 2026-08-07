import {
  SseTransport,
  WebSocketTransport,
  type EventSourceCtor,
  type Transport,
  type WebSocketCtor,
} from './transport.js'

export type MessageHandler = (data: unknown) => void
export type LifecycleEvent = 'open' | 'close' | 'error'

export interface Channel {
  /** Registers a handler for an event on this channel. Returns an unsubscribe fn. */
  on(event: string, handler: MessageHandler): () => void
  off(event: string, handler?: MessageHandler): void
  subscribe(): void
  unsubscribe(): void
}

export interface RealtimeClient {
  connect(): void
  close(): void
  channel(name: string): Channel
  on(event: LifecycleEvent, handler: (payload?: unknown) => void): () => void
  readonly connected: boolean
}

export interface RealtimeClientOptions {
  url: string
  /** 'websocket' (default, bidirectional) or 'sse' (receive-only). */
  transport?: 'websocket' | 'sse'
  /** Injectable implementations — default to the browser globals. */
  WebSocketImpl?: WebSocketCtor
  EventSourceImpl?: EventSourceCtor
  /** Auto-reconnect with exponential backoff. `false` disables it. */
  reconnect?: false | { minDelayMs?: number; maxDelayMs?: number }
}

const globalCtor = <T>(name: string): T | undefined =>
  (globalThis as Record<string, unknown>)[name] as T | undefined

export function createRealtimeClient(options: RealtimeClientOptions): RealtimeClient {
  const transport = makeTransport(options)

  const handlers = new Map<string, Map<string, Set<MessageHandler>>>()
  const lifecycle = new Map<LifecycleEvent, Set<(payload?: unknown) => void>>()
  const subscribed = new Set<string>()

  let connected = false
  let userClosed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const reconnect = options.reconnect === undefined ? {} : options.reconnect
  const minDelay = reconnect === false ? 0 : (reconnect.minDelayMs ?? 500)
  const maxDelay = reconnect === false ? 0 : (reconnect.maxDelayMs ?? 10_000)

  const emit = (event: LifecycleEvent, payload?: unknown): void => {
    for (const listener of lifecycle.get(event) ?? []) listener(payload)
  }

  const ensureSubscribed = (channel: string): void => {
    if (subscribed.has(channel)) return
    subscribed.add(channel)
    if (connected) transport.send({ type: 'subscribe', channel })
  }

  const scheduleReconnect = (): void => {
    if (reconnect === false) return
    const delay = Math.min(maxDelay, minDelay * 2 ** attempts) * (0.5 + Math.random() * 0.5)
    attempts += 1
    timer = setTimeout(() => transport.connect(transportHandlers), delay)
  }

  const transportHandlers = {
    onOpen(): void {
      connected = true
      attempts = 0
      for (const channel of subscribed) transport.send({ type: 'subscribe', channel })
      emit('open')
    },
    onMessage(message: { channel: string; event: string; data: unknown }): void {
      for (const handler of handlers.get(message.channel)?.get(message.event) ?? []) handler(message.data)
    },
    onClose(): void {
      connected = false
      emit('close')
      if (!userClosed) scheduleReconnect()
    },
    onError(error: unknown): void {
      emit('error', error)
    },
  }

  return {
    get connected() {
      return connected
    },
    connect(): void {
      userClosed = false
      transport.connect(transportHandlers)
    },
    close(): void {
      userClosed = true
      if (timer) clearTimeout(timer)
      transport.close()
    },
    on(event: LifecycleEvent, handler: (payload?: unknown) => void): () => void {
      const set = lifecycle.get(event) ?? lifecycle.set(event, new Set()).get(event)!
      set.add(handler)
      return () => set.delete(handler)
    },
    channel(name: string): Channel {
      return {
        on(event: string, handler: MessageHandler): () => void {
          ensureSubscribed(name)
          transport.track?.(event)
          const byEvent = handlers.get(name) ?? handlers.set(name, new Map()).get(name)!
          const set = byEvent.get(event) ?? byEvent.set(event, new Set()).get(event)!
          set.add(handler)
          return () => set.delete(handler)
        },
        off(event: string, handler?: MessageHandler): void {
          const set = handlers.get(name)?.get(event)
          if (!set) return
          if (handler) set.delete(handler)
          else set.clear()
        },
        subscribe(): void {
          ensureSubscribed(name)
        },
        unsubscribe(): void {
          subscribed.delete(name)
          handlers.delete(name)
          if (connected) transport.send({ type: 'unsubscribe', channel: name })
        },
      }
    },
  }
}

function makeTransport(options: RealtimeClientOptions): Transport {
  if (options.transport === 'sse') {
    const Ctor = options.EventSourceImpl ?? globalCtor<EventSourceCtor>('EventSource')
    if (!Ctor) throw new Error('No EventSource implementation; pass EventSourceImpl.')
    return new SseTransport(options.url, Ctor)
  }
  const Ctor = options.WebSocketImpl ?? globalCtor<WebSocketCtor>('WebSocket')
  if (!Ctor) throw new Error('No WebSocket implementation; pass WebSocketImpl.')
  return new WebSocketTransport(options.url, Ctor)
}
