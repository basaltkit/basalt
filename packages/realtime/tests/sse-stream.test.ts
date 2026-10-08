import { describe, expect, it } from 'vitest'
import { RealtimeHub, realtimeSse, sseFrame, sseStreamConnection, type SseStreamLike } from '../src/index.js'

/** An in-memory `sse()` stream: records what was sent, lets a test apply backpressure or disconnect. */
function fakeStream() {
  const sent: unknown[] = []
  const listeners: (() => void)[] = []
  let closed = false
  let full = false
  const stream: SseStreamLike & { disconnect(): void; setFull(v: boolean): void; sent: unknown[] } = {
    sent,
    send(event) {
      if (closed) return false
      sent.push(event)
      return !full
    },
    close() {
      if (closed) return
      closed = true
      for (const l of listeners) l()
    },
    onClose(listener) {
      if (closed) listener()
      else listeners.push(listener)
    },
    get closed() {
      return closed
    },
    disconnect() {
      this.close()
    },
    setFull(v) {
      full = v
    },
  }
  return stream
}

const message = { channel: 'notes', event: 'created', data: { id: 1 } }

describe('BK-079 · sseStreamConnection', () => {
  it('sends the same payload sseFrame puts on the wire', () => {
    const stream = fakeStream()
    sseStreamConnection({ tenantId: 'acme' }, stream).send(message)
    expect(stream.sent).toEqual([{ event: 'created', data: { channel: 'notes', data: { id: 1 } } }])
    expect(sseFrame(message)).toBe(`event: created\ndata: ${JSON.stringify((stream.sent[0] as { data: unknown }).data)}\n\n`)
  })

  it('throws only once the stream is closed', () => {
    const stream = fakeStream()
    const connection = sseStreamConnection({ tenantId: 'acme' }, stream)
    stream.close()
    expect(() => connection.send(message)).toThrow(/closed/)
  })

  it('does not throw on backpressure, and closes after maxBackpressure consecutive pressured sends', () => {
    const stream = fakeStream()
    const connection = sseStreamConnection({ tenantId: 'acme' }, stream, { maxBackpressure: 3 })
    stream.setFull(true)
    connection.send(message)
    connection.send(message)
    stream.setFull(false)
    connection.send(message) // goes through: the count resets
    stream.setFull(true)
    connection.send(message)
    connection.send(message)
    expect(stream.closed).toBe(false)
    connection.send(message)
    expect(stream.closed).toBe(true)
  })

  it('a pressured connection is not pruned by the hub', async () => {
    const hub = new RealtimeHub()
    await hub.start()
    const stream = fakeStream()
    stream.setFull(true)
    const connection = sseStreamConnection({ tenantId: 'acme', id: 'c1' }, stream)
    hub.register(connection)
    await hub.subscribe('c1', 'notes')
    await hub.publish('acme', 'notes', 'created', {})
    expect(hub.count('acme', 'notes')).toBe(1)
  })
})

describe('BK-079 · realtimeSse', () => {
  it('registers, subscribes, runs onOpen, and unregisters on disconnect', async () => {
    const hub = new RealtimeHub()
    await hub.start()
    const stream = fakeStream()
    const opened: string[] = []
    const running = realtimeSse(hub, {
      meta: { tenantId: 'acme', userId: 'ana' },
      channels: ['notes', 'tasks'],
      onOpen: (c) => {
        opened.push(c.tenantId)
      },
    })(stream)
    await new Promise((r) => setTimeout(r, 0))
    expect(opened).toEqual(['acme'])
    expect(hub.count('acme', 'notes')).toBe(1)
    expect(hub.presence('acme', 'tasks')).toEqual(['ana'])

    await hub.publish('acme', 'notes', 'created', { id: 7 })
    expect(stream.sent).toEqual([{ event: 'created', data: { channel: 'notes', data: { id: 7 } } }])

    stream.disconnect()
    await running // the producer finishes once the client is gone
    expect(hub.count('acme', 'notes')).toBe(0)
  })

  it('closes the stream when authorize refuses a channel', async () => {
    const hub = new RealtimeHub(undefined, { authorize: (_c, channel) => channel !== 'admin' })
    await hub.start()
    const stream = fakeStream()
    let opened = false
    await realtimeSse(hub, {
      meta: { tenantId: 'acme' },
      channels: ['notes', 'admin'],
      onOpen: () => {
        opened = true
      },
    })(stream)
    expect(stream.closed).toBe(true)
    expect(opened).toBe(false)
    expect(hub.count('acme', 'notes')).toBe(0)
  })

  it('does nothing on a stream that is already closed', async () => {
    const hub = new RealtimeHub()
    const stream = fakeStream()
    stream.close()
    await realtimeSse(hub, { meta: { tenantId: 'acme', id: 'x' }, channels: ['notes'] })(stream)
    expect(hub.count('acme', 'notes')).toBe(0)
  })

  it('returns on a closed stream that does not replay onClose to late listeners', async () => {
    const hub = new RealtimeHub()
    const stream: SseStreamLike = { send: () => false, close() {}, onClose() {}, closed: true }
    await realtimeSse(hub, { meta: { tenantId: 'acme', id: 'y' }, channels: ['notes'] })(stream)
    expect(hub.count('acme', 'notes')).toBe(0)
  })
})
