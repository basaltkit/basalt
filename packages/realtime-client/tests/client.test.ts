import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealtimeClient, type EventSourceLike, type RealtimeMessage, type WebSocketLike } from '../src/index.js'

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = []
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
  }
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  readonly sent: string[] = []
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.onclose?.()
  }
  // test helpers
  open(): void {
    this.onopen?.()
  }
  deliver(message: RealtimeMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  get commands(): unknown[] {
    return this.sent.map((s) => JSON.parse(s))
  }
}

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = []
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!
  }
  onopen: (() => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  private readonly listeners = new Map<string, (event: { data: string }) => void>()
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }
  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener)
  }
  close(): void {}
  open(): void {
    this.onopen?.()
  }
  emit(event: string, payload: { channel: string; data: unknown }): void {
    this.listeners.get(event)?.({ data: JSON.stringify(payload) })
  }
}

afterEach(() => {
  FakeWebSocket.instances = []
  FakeEventSource.instances = []
})

describe('createRealtimeClient (WebSocket)', () => {
  it('subscribes on open and routes events by channel + event', () => {
    const client = createRealtimeClient({ url: 'ws://x', WebSocketImpl: FakeWebSocket })
    const received: unknown[] = []
    client.channel('notes').on('created', (d) => received.push(d))
    client.connect()

    const ws = FakeWebSocket.last
    ws.open()
    expect(client.connected).toBe(true)
    expect(ws.commands).toContainEqual({ type: 'subscribe', channel: 'notes' })

    ws.deliver({ channel: 'notes', event: 'created', data: { id: 1 } })
    expect(received).toEqual([{ id: 1 }])

    // other event / channel are ignored
    ws.deliver({ channel: 'notes', event: 'deleted', data: {} })
    ws.deliver({ channel: 'tasks', event: 'created', data: {} })
    expect(received).toHaveLength(1)
  })

  it('subscribes immediately when a handler is added while connected', () => {
    const client = createRealtimeClient({ url: 'ws://x', WebSocketImpl: FakeWebSocket })
    client.connect()
    FakeWebSocket.last.open()
    client.channel('tasks').on('x', () => {})
    expect(FakeWebSocket.last.commands).toContainEqual({ type: 'subscribe', channel: 'tasks' })
  })

  it('off() and unsubscribe() stop delivery', () => {
    const client = createRealtimeClient({ url: 'ws://x', WebSocketImpl: FakeWebSocket })
    const seen: unknown[] = []
    const handler = (d: unknown) => seen.push(d)
    const channel = client.channel('notes')
    channel.on('created', handler)
    client.connect()
    FakeWebSocket.last.open()

    channel.off('created', handler)
    FakeWebSocket.last.deliver({ channel: 'notes', event: 'created', data: 1 })
    expect(seen).toHaveLength(0)

    channel.unsubscribe()
    expect(FakeWebSocket.last.commands).toContainEqual({ type: 'unsubscribe', channel: 'notes' })
  })

  it('emits lifecycle events', () => {
    const client = createRealtimeClient({ url: 'ws://x', WebSocketImpl: FakeWebSocket, reconnect: false })
    const events: string[] = []
    client.on('open', () => events.push('open'))
    client.on('close', () => events.push('close'))
    client.connect()
    FakeWebSocket.last.open()
    FakeWebSocket.last.close()
    expect(events).toEqual(['open', 'close'])
  })

  it('reconnects with backoff and re-subscribes; user close() stops it', () => {
    vi.useFakeTimers()
    try {
      const client = createRealtimeClient({
        url: 'ws://x',
        WebSocketImpl: FakeWebSocket,
        reconnect: { minDelayMs: 100, maxDelayMs: 100 },
      })
      client.channel('notes').on('created', () => {})
      client.connect()
      FakeWebSocket.last.open()
      const before = FakeWebSocket.instances.length

      FakeWebSocket.last.close() // server dropped the connection
      expect(client.connected).toBe(false)
      vi.advanceTimersByTime(200)
      expect(FakeWebSocket.instances.length).toBe(before + 1) // reconnected

      FakeWebSocket.last.open()
      expect(FakeWebSocket.last.commands).toContainEqual({ type: 'subscribe', channel: 'notes' }) // re-subscribed

      // a user-initiated close must NOT reconnect
      client.close()
      const count = FakeWebSocket.instances.length
      vi.advanceTimersByTime(1000)
      expect(FakeWebSocket.instances.length).toBe(count)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createRealtimeClient (SSE)', () => {
  it('receives events over SSE and routes by channel', () => {
    const client = createRealtimeClient({ url: 'http://x/sse', transport: 'sse', EventSourceImpl: FakeEventSource })
    const received: unknown[] = []
    client.channel('notes').on('created', (d) => received.push(d))
    client.connect()
    FakeEventSource.last.open()

    FakeEventSource.last.emit('created', { channel: 'notes', data: { id: 2 } })
    expect(received).toEqual([{ id: 2 }])

    // same event name, different channel → filtered out
    FakeEventSource.last.emit('created', { channel: 'tasks', data: { id: 3 } })
    expect(received).toHaveLength(1)
  })
})

describe('transport resolution', () => {
  it('throws a clear error when no implementation is available', () => {
    const globals = globalThis as Record<string, unknown>
    const saved = globals['WebSocket']
    delete globals['WebSocket'] // Node 24 ships a global WebSocket; force the no-impl path
    try {
      expect(() => createRealtimeClient({ url: 'ws://x' })).toThrow(/WebSocket implementation/)
    } finally {
      globals['WebSocket'] = saved
    }
  })
})
