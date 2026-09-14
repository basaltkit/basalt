import { describe, expect, it, vi } from 'vitest'
import { createApp, runWithContext, type Container } from '@basaltkit/core'
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
    'test:matter_opened': { matter: { id: number; folder?: string } }
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

describe('bridge tenant from context (schema-/database-per-tenant apps)', () => {
  const subscriber = async (app: { container: Container }, tenantId: string, channel: string) => {
    const hub = app.container.get(REALTIME_HUB)
    const conn = new FakeConnection(`c-${tenantId}`, tenantId, 'u1')
    hub.register(conn)
    await hub.subscribe(conn.id, channel)
    return conn
  }

  it('a rule without `tenant` delivers to the tenant in context', async () => {
    const skipped: unknown[] = []
    const app = await createApp({
      plugins: [
        realtimePlugin({
          onBridgeSkipped: (info) => void skipped.push(info),
          bridge: [
            bridgeRule({
              hook: 'test:matter_opened',
              channel: (p) => `matters:${p.matter.folder ?? 'all'}`,
              event: 'opened',
              data: (p) => p.matter,
            }),
          ],
        }),
      ],
    }).boot()
    const acme = await subscriber(app, 'acme', 'matters:all')
    const globex = await subscriber(app, 'globex', 'matters:all')

    await runWithContext({ tenant: { id: 'acme' } }, () =>
      app.hooks.emit('test:matter_opened', { matter: { id: 1 } }),
    )
    expect(acme.received).toEqual([{ channel: 'matters:all', event: 'opened', data: { id: 1 } }])
    expect(globex.received).toHaveLength(0)
    expect(skipped).toHaveLength(0)
    await app.shutdown()
  })

  it('without a tenant in context: not delivered, reported as no-tenant', async () => {
    const skipped: unknown[] = []
    const app = await createApp({
      plugins: [
        realtimePlugin({
          onBridgeSkipped: (info) => void skipped.push(info),
          bridge: [
            bridgeRule({ hook: 'test:matter_opened', channel: 'matters', event: 'opened' }),
            bridgeRule({
              hook: 'test:matter_opened',
              channel: (p) => `matters:${p.matter.folder!.toUpperCase()}`,
              event: 'opened:folder',
            }),
          ],
        }),
      ],
    }).boot()
    const acme = await subscriber(app, 'acme', 'matters')

    await app.hooks.emit('test:matter_opened', { matter: { id: 1 } })
    await runWithContext({ requestId: 'r1' }, () =>
      app.hooks.emit('test:matter_opened', { matter: { id: 2 } }),
    )
    expect(acme.received).toHaveLength(0)
    expect(skipped).toEqual([
      { hook: 'test:matter_opened', channel: 'matters', event: 'opened', reason: 'no-tenant' },
      // a function channel that throws falls back to the placeholder
      { hook: 'test:matter_opened', channel: '<dynamic>', event: 'opened:folder', reason: 'no-tenant' },
      { hook: 'test:matter_opened', channel: 'matters', event: 'opened', reason: 'no-tenant' },
      { hook: 'test:matter_opened', channel: '<dynamic>', event: 'opened:folder', reason: 'no-tenant' },
    ])
    await app.shutdown()
  })

  it('the default onBridgeSkipped warns once per rule, not once per event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = await createApp({
        plugins: [
          realtimePlugin({
            bridge: [
              bridgeRule({ hook: 'test:matter_opened', channel: 'matters', event: 'opened' }),
              bridgeRule({ hook: 'test:matter_opened', channel: 'matters', event: 'reopened' }),
            ],
          }),
        ],
      }).boot()
      for (let i = 0; i < 5; i++) await app.hooks.emit('test:matter_opened', { matter: { id: i } })
      expect(warn).toHaveBeenCalledTimes(2) // one per rule
      expect(String(warn.mock.calls[0]![0])).toContain(
        '[basalt:realtime] bridge skipped (hook "test:matter_opened" -> channel "matters", event "opened")',
      )
      expect(String(warn.mock.calls[1]![0])).toContain('event "reopened"')
      await app.shutdown()
    } finally {
      warn.mockRestore()
    }
  })

  it('a `tenant` returning undefined skips silently (explicit opt-out)', async () => {
    const skipped: unknown[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = await createApp({
        plugins: [
          realtimePlugin({
            onBridgeSkipped: (info) => void skipped.push(info),
            bridge: [
              bridgeRule({ hook: 'test:note_created', tenant: () => undefined, channel: 'notes', event: 'created' }),
            ],
          }),
        ],
      }).boot()
      const acme = await subscriber(app, 'acme', 'notes')
      // even with a tenant in context, the explicit resolver wins
      await runWithContext({ tenant: { id: 'acme' } }, () =>
        app.hooks.emit('test:note_created', { tenantId: 'acme', note: { id: 1 } }),
      )
      await app.hooks.emit('test:note_created', { tenantId: 'acme', note: { id: 2 } })
      expect(acme.received).toHaveLength(0)
      expect(skipped).toHaveLength(0)
      expect(warn).not.toHaveBeenCalled()
      await app.shutdown()
    } finally {
      warn.mockRestore()
    }
  })

  it('an explicit `tenant` wins over the tenant in context', async () => {
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
    const acme = await subscriber(app, 'acme', 'notes')
    const globex = await subscriber(app, 'globex', 'notes')

    await runWithContext({ tenant: { id: 'globex' } }, () =>
      app.hooks.emit('test:note_created', { tenantId: 'acme', note: { id: 9 } }),
    )
    expect(acme.received).toEqual([{ channel: 'notes', event: 'created', data: { id: 9 } }])
    expect(globex.received).toHaveLength(0)
    await app.shutdown()
  })

  it('type-checks tenant/channel/data against the hook payload', () => {
    bridgeRule({
      hook: 'test:matter_opened',
      // @ts-expect-error — the payload has no tenantId
      tenant: (p) => p.tenantId,
      channel: 'matters',
      event: 'opened',
    })
    bridgeRule({
      hook: 'test:matter_opened',
      // @ts-expect-error — matter.id is a number, channel must be a string
      channel: (p) => p.matter.id,
      event: 'opened',
    })
    bridgeRule({
      hook: 'test:matter_opened',
      channel: 'matters',
      event: 'opened',
      // @ts-expect-error — the payload has no note
      data: (p) => p.note,
    })
  })
})

describe('bridge failures do not fail the domain write (review 2026-08-b, Q-1)', () => {
  /** Backplane whose publish always rejects — a "Redis is down" stand-in. */
  const downBackplane = () => ({
    async start() {},
    async publish() {
      throw new Error('backplane down')
    },
    subscribe() {},
    async close() {},
  })

  it('hooks.emit resolves even when the broadcast rejects, and the failure is observable', async () => {
    const failures: unknown[] = []
    const app = await createApp({
      plugins: [
        realtimePlugin({
          backplane: downBackplane() as never,
          onBridgeError: (error) => void failures.push(error),
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

    // The domain write's hook emission must NOT reject because a cosmetic
    // realtime fan-out failed.
    await expect(
      app.hooks.emit('test:note_created', { tenantId: 'acme', note: { id: 7 } }),
    ).resolves.toBeUndefined()

    // ...but the failure is not swallowed silently either.
    await new Promise((r) => setTimeout(r, 10))
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toBe('backplane down')
    await app.shutdown()
  })
})

describe('deliverLocal crash-safety (review 2026-08-b, Q-3)', () => {
  class ThrowingConnection extends FakeConnection {
    override send(): void {
      throw new Error('socket already closed')
    }
  }

  it('one dead socket does not blackhole the rest, is pruned, and is observable', async () => {
    const failures: { connectionId: string }[] = []
    const hub = new RealtimeHub(undefined, {
      onDeliveryError: (_error, info) => void failures.push(info),
    })
    await hub.start()
    const healthy1 = new FakeConnection('a', 'acme', 'u1')
    const dead = new ThrowingConnection('b', 'acme', 'u2')
    const healthy2 = new FakeConnection('c', 'acme', 'u3')
    for (const conn of [healthy1, dead, healthy2]) hub.register(conn)
    for (const id of ['a', 'b', 'c']) await hub.subscribe(id, 'notes')

    await hub.publish('acme', 'notes', 'created', { id: 1 })

    // Pre-fix: the throw from "b" aborted the loop — "c" received NOTHING and
    // the exception escaped toward the backplane's message emitter (fatal on
    // a real ioredis subscriber). Post-fix: everyone else is delivered.
    expect(healthy1.received).toHaveLength(1)
    expect(healthy2.received).toHaveLength(1)

    // the failure is observable and the dead connection is pruned
    expect(failures).toMatchObject([{ connectionId: 'b' }])
    expect(hub.presence('acme', 'notes')).not.toContain('u2')

    // subsequent broadcasts flow cleanly with no repeat failures
    await hub.publish('acme', 'notes', 'created', { id: 2 })
    expect(healthy2.received).toHaveLength(2)
    expect(failures).toHaveLength(1)
  })

  it('a malformed backplane message is dropped without crashing (redis driver)', async () => {
    const { RedisBackplane } = await import('../src/drivers/redis.js')
    let messageListener!: (channel: string, raw: string) => void
    const client = {
      publish: async () => 1,
      subscribe: async () => 1,
      on: (_e: 'message', l: (channel: string, raw: string) => void) => void (messageListener = l),
    }
    const backplane = new RedisBackplane({ publisher: client, subscriber: client })
    const seen: unknown[] = []
    await backplane.subscribe((m) => void seen.push(m))
    // garbage JSON and a valid-JSON-but-wrong-shape message must both be
    // dropped, not thrown into ioredis's emitter (which would be fatal)
    expect(() => messageListener('basalt:realtime', 'not-json{')).not.toThrow()
    expect(() => messageListener('basalt:realtime', JSON.stringify({ nope: true }))).not.toThrow()
    messageListener('basalt:realtime', JSON.stringify({ tenantId: 't', channel: 'c', event: 'e', data: 1 }))
    expect(seen).toEqual([{ tenantId: 't', channel: 'c', event: 'e', data: 1 }])
  })
})
