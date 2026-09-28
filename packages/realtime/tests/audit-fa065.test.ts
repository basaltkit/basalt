import { describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  RealtimeHub,
  RedisBackplane,
  sseConnection,
  sseFrame,
  type BackplaneMessage,
  type Connection,
  type RealtimeMessage,
} from '../src/index.js'

class FakeConnection implements Connection {
  readonly received: RealtimeMessage[] = []
  closed = false
  constructor(
    readonly id: string,
    readonly tenantId: string,
    readonly userId?: string,
  ) {}
  send(message: RealtimeMessage): void {
    // Serialize like the real transports do (websocketConnection/sseConnection).
    JSON.stringify(message)
    this.received.push(message)
  }
  close(): void {
    this.closed = true
  }
}

/** A promise plus its resolver — lets a test hold `authorize` open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('FA-065: subscribe re-checks the connection after the async authorize gate', () => {
  it('a connection unregistered while authorize is pending leaves no ghost entry', async () => {
    const gate = deferred<boolean>()
    const hub = new RealtimeHub(undefined, { authorize: () => gate.promise })
    await hub.start()
    const conn = new FakeConnection('a', 'acme', 'u1')
    hub.register(conn)

    const pending = hub.subscribe('a', 'notes')
    hub.unregister('a') // the socket closed while the gate was deciding
    gate.resolve(true)

    expect(await pending).toBe(false)
    expect(hub.count('acme', 'notes')).toBe(0)
    expect(hub.presence('acme', 'notes')).toEqual([])
  })

  it("a different connection reusing the id during authorize does not inherit the old tenant's channel", async () => {
    const gate = deferred<boolean>()
    const hub = new RealtimeHub(undefined, {
      authorize: (connection) => (connection.tenantId === 'acme' ? gate.promise : true),
    })
    await hub.start()
    const acme = new FakeConnection('shared', 'acme', 'u1')
    hub.register(acme)
    const pending = hub.subscribe('shared', 'secrets')

    const globex = new FakeConnection('shared', 'globex', 'u2')
    hub.register(globex) // replaces the acme connection under the same id
    gate.resolve(true)
    expect(await pending).toBe(false)

    await hub.publish('acme', 'secrets', 'leak', 1)
    await hub.publish('globex', 'secrets', 'leak', 1)
    expect(globex.received).toEqual([])
    expect(hub.count('acme', 'secrets')).toBe(0)
  })

  it('concurrent subscribes cannot exceed maxSubscriptionsPerConnection', async () => {
    const gate = deferred<boolean>()
    const hub = new RealtimeHub(undefined, { authorize: () => gate.promise, maxSubscriptionsPerConnection: 2 })
    await hub.start()
    hub.register(new FakeConnection('a', 'acme'))

    const results = Promise.all(Array.from({ length: 10 }, (_, i) => hub.subscribe('a', `c${i}`)))
    gate.resolve(true)
    const accepted = (await results).filter(Boolean)

    expect(accepted).toHaveLength(2)
    const joined = Array.from({ length: 10 }, (_, i) => hub.count('acme', `c${i}`)).reduce((a, b) => a + b, 0)
    expect(joined).toBe(2)
  })

  it('refuses a non-string channel instead of throwing or keying on an object', async () => {
    const hub = new RealtimeHub()
    await hub.start()
    hub.register(new FakeConnection('a', 'acme'))
    for (const bad of [null, undefined, 42, ['notes'], { length: 3 }]) {
      await expect(hub.subscribe('a', bad as unknown as string)).resolves.toBe(false)
    }
  })
})

describe('FA-065: a non-serializable payload does not disconnect every subscriber', () => {
  it('publish rejects the payload and leaves the subscribers registered', async () => {
    const failures: unknown[] = []
    const hub = new RealtimeHub(undefined, { onDeliveryError: (e) => void failures.push(e) })
    await hub.start()
    const a = new FakeConnection('a', 'acme', 'u1')
    const b = new FakeConnection('b', 'acme', 'u2')
    hub.register(a)
    hub.register(b)
    await hub.subscribe('a', 'notes')
    await hub.subscribe('b', 'notes')

    const circular: Record<string, unknown> = {}
    circular.self = circular
    await expect(hub.publish('acme', 'notes', 'x', { big: 1n })).rejects.toThrow(TypeError)
    await expect(hub.publish('acme', 'notes', 'x', circular)).rejects.toThrow(TypeError)

    expect(failures).toEqual([])
    expect(hub.count('acme', 'notes')).toBe(2)
    expect(hub.presence('acme', 'notes').sort()).toEqual(['u1', 'u2'])
    await hub.publish('acme', 'notes', 'ok', 1)
    expect(a.received).toHaveLength(1)
    expect(b.received).toHaveLength(1)
  })

  it('a connection pruned after a failed send is also closed (no half-open socket)', async () => {
    class Dead extends FakeConnection {
      override send(): void {
        throw new Error('gone')
      }
    }
    const hub = new RealtimeHub(undefined, { onDeliveryError: () => {} })
    await hub.start()
    const dead = new Dead('d', 'acme')
    hub.register(dead)
    await hub.subscribe('d', 'notes')
    await hub.publish('acme', 'notes', 'x', 1)
    expect(dead.closed).toBe(true)
    expect(hub.count('acme', 'notes')).toBe(0)
  })
})

describe('FA-065: SSE frames cannot be injected through the event name', () => {
  it('strips CR/LF from the event so one message is exactly one frame', () => {
    const frame = sseFrame({ channel: 'notes', event: 'x\ndata: {"forged":true}\n\nevent: y\r', data: 1 })
    expect(frame.split('\n\n')).toHaveLength(2) // one frame + the trailing empty string
    expect(frame.startsWith('event: xdata: {"forged":true}event: y\n')).toBe(true)
    expect(frame.match(/^data: /gm)).toHaveLength(1)
  })

  it('an injected event never reaches the stream as a second frame', () => {
    const chunks: string[] = []
    const conn = sseConnection({ tenantId: 'acme' }, { write: (c) => chunks.push(c), end: () => {} })
    conn.send({ channel: 'n', event: 'a\n\nevent: admin\ndata: {}', data: null })
    expect(chunks.join('').match(/^event: /gm)).toHaveLength(1)
  })
})

describe('FA-066: RedisBackplane namespaces and optionally signs its messages', () => {
  function pair() {
    let listener!: (channel: string, raw: string) => void
    const published: [string, string][] = []
    const client = {
      publish: async (channel: string, message: string) => void published.push([channel, message]),
      subscribe: async () => 1,
      on: (_e: 'message', l: (channel: string, raw: string) => void) => void (listener = l),
    }
    return { client, published, deliver: (channel: string, raw: string) => listener(channel, raw) }
  }
  const message: BackplaneMessage = { tenantId: 'acme', channel: 'notes', event: 'created', data: { id: 1 } }

  it('with a secret: signed messages round-trip, forged/unsigned/tampered ones are dropped', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { client, published, deliver } = pair()
      const backplane = new RedisBackplane({ publisher: client, subscriber: client, secret: 's3cret' })
      const seen: BackplaneMessage[] = []
      await backplane.subscribe((m) => void seen.push(m))

      await backplane.publish(message)
      const [channel, raw] = published[0]!
      expect(raw).not.toBe(JSON.stringify(message)) // enveloped
      deliver(channel, raw)
      expect(seen).toEqual([message])

      // anyone else able to PUBLISH on the Redis:
      deliver(channel, JSON.stringify({ ...message, event: 'forged' })) // unsigned
      const envelope = JSON.parse(raw) as { payload: string; sig: string }
      deliver(channel, JSON.stringify({ ...envelope, payload: envelope.payload.replace('created', 'forged') })) // tampered
      const wrongKey = createHmac('sha256', 'guess').update(envelope.payload).digest('base64url')
      deliver(channel, JSON.stringify({ payload: envelope.payload, sig: wrongKey })) // wrong key
      expect(seen).toEqual([message])
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('accepts any of several secrets (rotation) and signs with the first', async () => {
    const a = pair()
    const oldNode = new RedisBackplane({ publisher: a.client, subscriber: a.client, secret: 'old' })
    await oldNode.publish(message)

    const b = pair()
    const newNode = new RedisBackplane({ publisher: b.client, subscriber: b.client, secret: ['new', 'old'] })
    const seen: BackplaneMessage[] = []
    await newNode.subscribe((m) => void seen.push(m))
    b.deliver('basalt:realtime', a.published[0]![1])
    expect(seen).toEqual([message])
  })

  it('rejects an empty secret at construction', () => {
    const { client } = pair()
    expect(() => new RedisBackplane({ publisher: client, subscriber: client, secret: '' })).toThrow(/secret/)
    expect(() => new RedisBackplane({ publisher: client, subscriber: client, secret: [] })).toThrow(/secret/)
  })

  it('without a secret the wire format is unchanged (plain JSON)', async () => {
    const { client, published } = pair()
    const backplane = new RedisBackplane({ publisher: client, subscriber: client })
    await backplane.publish(message)
    expect(JSON.parse(published[0]![1])).toEqual(message)
  })
})
