import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import {
  Realtime,
  RealtimeHub,
  RedisBackplane,
  REALTIME_HUB,
  bridgeRule,
  realtimePlugin,
  sseConnection,
  sseFrame,
  websocketConnection,
  type Connection,
  type RealtimeMessage,
} from '../src/index.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'test:note_created': { tenantId: string; note: { id: number } }
  }
}

class FakeConnection implements Connection {
  readonly received: RealtimeMessage[] = []
  closed = false
  constructor(
    readonly id: string,
    readonly tenantId: string,
    readonly userId?: string,
  ) {}
  send(message: RealtimeMessage): void {
    this.received.push(message)
  }
  close(): void {
    this.closed = true
  }
}

describe('RealtimeHub', () => {
  it('delivers only to subscribers of the same tenant + channel', async () => {
    const hub = new RealtimeHub()
    await hub.start()
    const a = new FakeConnection('a', 'acme', 'u1')
    const b = new FakeConnection('b', 'acme', 'u2')
    const otherTenant = new FakeConnection('c', 'globex', 'u3')
    const otherChannel = new FakeConnection('d', 'acme', 'u4')
    ;[a, b, otherTenant, otherChannel].forEach((c) => hub.register(c))
    hub.subscribe('a', 'notes')
    hub.subscribe('b', 'notes')
    hub.subscribe('c', 'notes') // different tenant
    hub.subscribe('d', 'tasks') // different channel

    await hub.publish('acme', 'notes', 'created', { id: 1 })
    expect(a.received).toEqual([{ channel: 'notes', event: 'created', data: { id: 1 } }])
    expect(b.received).toHaveLength(1)
    expect(otherTenant.received).toHaveLength(0)
    expect(otherChannel.received).toHaveLength(0)
  })

  it('enforces the authorize gate: a refused channel is never joined', async () => {
    // only allow a user to join their OWN private channel
    const hub = new RealtimeHub(undefined, {
      authorize: (conn, channel) => channel === `user:${conn.userId}` || channel === 'public',
    })
    await hub.start()
    const mallory = new FakeConnection('m', 'acme', 'mallory')
    hub.register(mallory)

    expect(await hub.subscribe('m', 'user:victim')).toBe(false) // someone else's private channel
    expect(await hub.subscribe('m', 'admin')).toBe(false)
    expect(await hub.subscribe('m', 'user:mallory')).toBe(true) // own channel
    expect(await hub.subscribe('m', 'public')).toBe(true)

    // a message on the refused channel never reaches the connection
    await hub.publish('acme', 'user:victim', 'secret', { pii: true })
    expect(mallory.received).toHaveLength(0)
    await hub.publish('acme', 'user:mallory', 'ok', { x: 1 })
    expect(mallory.received).toHaveLength(1)
  })

  it('bounds subscriptions per connection and channel-name length (DoS)', async () => {
    const hub = new RealtimeHub(undefined, { maxSubscriptionsPerConnection: 2, maxChannelLength: 8 })
    await hub.start()
    const c = new FakeConnection('c', 'acme', 'u1')
    hub.register(c)
    expect(await hub.subscribe('c', 'a')).toBe(true)
    expect(await hub.subscribe('c', 'b')).toBe(true)
    expect(await hub.subscribe('c', 'c')).toBe(false) // cap reached
    expect(await hub.subscribe('c', 'x'.repeat(9))).toBe(false) // too long
    expect(await hub.subscribe('c', '')).toBe(false) // empty
  })

  it('tracks presence (distinct user ids) and clears on unsubscribe/unregister', () => {
    const hub = new RealtimeHub()
    const a = new FakeConnection('a', 'acme', 'u1')
    const b = new FakeConnection('b', 'acme', 'u1') // same user, 2 connections
    const c = new FakeConnection('c', 'acme', 'u2')
    ;[a, b, c].forEach((x) => hub.register(x))
    ;['a', 'b', 'c'].forEach((id) => hub.subscribe(id, 'room'))

    expect(hub.presence('acme', 'room').sort()).toEqual(['u1', 'u2'])
    expect(hub.count('acme', 'room')).toBe(3)

    hub.unsubscribe('c', 'room')
    expect(hub.presence('acme', 'room')).toEqual(['u1'])
    hub.unregister('a')
    expect(hub.count('acme', 'room')).toBe(1) // only b left
  })

  it('stops delivering after unsubscribe', async () => {
    const hub = new RealtimeHub()
    await hub.start()
    const a = new FakeConnection('a', 'acme', 'u1')
    hub.register(a)
    hub.subscribe('a', 'notes')
    hub.unsubscribe('a', 'notes')
    await hub.publish('acme', 'notes', 'created', {})
    expect(a.received).toHaveLength(0)
  })

  it('closes and clears all connections', async () => {
    const hub = new RealtimeHub()
    const a = new FakeConnection('a', 'acme')
    hub.register(a)
    await hub.close()
    expect(a.closed).toBe(true)
    expect(hub.count('acme', 'x')).toBe(0)
  })
})

class FakeRedis {
  readonly published: [string, string][] = []
  readonly subscribed: string[] = []
  private listener: ((channel: string, message: string) => void) | undefined
  async publish(channel: string, message: string): Promise<void> {
    this.published.push([channel, message])
  }
  async subscribe(channel: string): Promise<void> {
    this.subscribed.push(channel)
  }
  on(_event: 'message', listener: (channel: string, message: string) => void): void {
    this.listener = listener
  }
  deliver(channel: string, message: string): void {
    this.listener?.(channel, message)
  }
}

describe('RedisBackplane', () => {
  it('publishes to Redis and delivers echoed messages to local connections', async () => {
    const publisher = new FakeRedis()
    const subscriber = new FakeRedis()
    const hub = new RealtimeHub(new RedisBackplane({ publisher, subscriber }))
    await hub.start()
    expect(subscriber.subscribed).toEqual(['basalt:realtime'])

    const conn = new FakeConnection('a', 'acme', 'u1')
    hub.register(conn)
    hub.subscribe('a', 'notes')

    await hub.publish('acme', 'notes', 'created', { id: 1 })
    // emit went out via the publisher, not delivered locally yet
    expect(publisher.published[0]![0]).toBe('basalt:realtime')
    expect(conn.received).toHaveLength(0)

    // Redis echoes the message to every subscriber (including this instance)
    subscriber.deliver('basalt:realtime', publisher.published[0]![1])
    expect(conn.received).toEqual([{ channel: 'notes', event: 'created', data: { id: 1 } }])
  })
})

describe('transport helpers', () => {
  it('formats SSE frames', () => {
    expect(sseFrame({ channel: 'notes', event: 'created', data: { id: 1 } })).toBe(
      'event: created\ndata: {"channel":"notes","data":{"id":1}}\n\n',
    )
  })

  it('builds SSE and WebSocket connections that write correctly', () => {
    const chunks: string[] = []
    let ended = false
    const sse = sseConnection({ tenantId: 'acme', userId: 'u1' }, { write: (c) => chunks.push(c), end: () => (ended = true) })
    expect(sse.tenantId).toBe('acme')
    sse.send({ channel: 'n', event: 'e', data: 1 })
    expect(chunks[0]).toContain('event: e')
    sse.close()
    expect(ended).toBe(true)

    const sent: string[] = []
    const ws = websocketConnection({ tenantId: 'acme' }, { send: (d) => sent.push(d), close: () => {} })
    ws.send({ channel: 'n', event: 'e', data: 1 })
    expect(JSON.parse(sent[0]!)).toEqual({ channel: 'n', event: 'e', data: 1 })
  })
})

describe('Realtime service + events bridge', () => {
  it('to().channel().emit() delivers and exposes presence', async () => {
    const hub = new RealtimeHub()
    await hub.start()
    const realtime = new Realtime(hub)
    const conn = new FakeConnection('a', 'acme', 'u1')
    hub.register(conn)
    hub.subscribe('a', 'notes')

    await realtime.to('acme').channel('notes').emit('x', 1)
    expect(conn.received[0]).toMatchObject({ event: 'x', data: 1 })
    expect(realtime.to('acme').channel('notes').presence()).toEqual(['u1'])
    expect(realtime.to('acme').channel('notes').count()).toBe(1)
  })

  it('bridges a domain hook straight to a realtime channel', async () => {
    const app = await createApp({
      plugins: [
        realtimePlugin({
          bridge: [
            bridgeRule({
              hook: 'test:note_created',
              tenant: (p) => p.tenantId,
              channel: 'notes',
              event: 'created',
              data: (p) => p.note,
            }),
          ],
        }),
      ],
    }).boot()
    const hub = app.container.get(REALTIME_HUB)
    const conn = new FakeConnection('a', 'acme', 'u1')
    hub.register(conn)
    hub.subscribe('a', 'notes')

    await app.hooks.emit('test:note_created', { tenantId: 'acme', note: { id: 7 } })
    expect(conn.received).toEqual([{ channel: 'notes', event: 'created', data: { id: 7 } }])
    await app.shutdown()
  })
})
