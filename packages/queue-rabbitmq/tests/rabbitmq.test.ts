import { describe, expect, it } from 'vitest'
import { RabbitmqQueueDriver, type AmqpChannel, type AmqpMessage } from '../src/index.js'

class FakeChannel implements AmqpChannel {
  readonly asserted: { queue: string; options?: Record<string, unknown> | undefined }[] = []
  readonly sent: { queue: string; content: Uint8Array; options?: Record<string, unknown> | undefined }[] = []
  acked = 0
  prefetched: number | undefined
  private consumer: ((msg: AmqpMessage | null) => void) | undefined
  private resolveReady!: () => void
  readonly ready = new Promise<void>((r) => (this.resolveReady = r))

  async assertQueue(queue: string, options?: Record<string, unknown>): Promise<unknown> {
    this.asserted.push({ queue, options })
    return {}
  }
  sendToQueue(queue: string, content: Uint8Array, options?: Record<string, unknown>): boolean {
    this.sent.push({ queue, content, options })
    return true
  }
  async consume(_queue: string, onMessage: (msg: AmqpMessage | null) => void): Promise<unknown> {
    this.consumer = onMessage
    this.resolveReady()
    return {}
  }
  ack(): void {
    this.acked++
  }
  async prefetch(count: number): Promise<void> {
    this.prefetched = count
  }
  async close(): Promise<void> {}

  deliver(headers: Record<string, unknown>, payload: unknown): void {
    this.consumer?.({
      content: new TextEncoder().encode(JSON.stringify(payload)),
      properties: { headers },
    })
  }
}

const driverWith = (channel: FakeChannel) =>
  new RabbitmqQueueDriver({ url: 'amqp://test', connect: async () => ({ createChannel: async () => channel, close: async () => {} }) })

const tick = () => new Promise((r) => setTimeout(r, 10))
const header = (m: { options?: Record<string, unknown> | undefined }, k: string) =>
  (m.options?.['headers'] as Record<string, unknown>)[k]

describe('RabbitmqQueueDriver', () => {
  it('declares full capabilities', () => {
    expect(new RabbitmqQueueDriver({ url: 'amqp://x' }).capabilities).toEqual({
      delayed: true,
      priority: true,
      retries: true,
      backoff: true,
    })
  })

  it('publishes to the queue with job headers and priority', async () => {
    const ch = new FakeChannel()
    await driverWith(ch).add('welcome', 'send-welcome', { name: 'Ada' }, { attempts: 1, priority: 5 })

    const msg = ch.sent.find((s) => s.queue === 'welcome')!
    expect(msg).toBeTruthy()
    expect(msg.options?.['priority']).toBe(5)
    expect(header(msg, 'x-basalt-job')).toBe('send-welcome')
    expect(header(msg, 'x-basalt-attempts')).toBe(1)
    // main queue asserted with priority support
    expect(ch.asserted.find((a) => a.queue === 'welcome')?.options?.['arguments']).toMatchObject({
      'x-max-priority': 10,
    })
  })

  it('routes a delayed job to the delay queue with a TTL', async () => {
    const ch = new FakeChannel()
    await driverWith(ch).add('welcome', 'send-welcome', { name: 'Bea' }, { attempts: 1, delayMs: 5000 })

    const delayed = ch.sent.find((s) => s.queue === 'welcome.delay')!
    expect(delayed.options?.['expiration']).toBe('5000')
    // the delay queue dead-letters back to the main queue
    expect(ch.asserted.find((a) => a.queue === 'welcome.delay')?.options?.['arguments']).toMatchObject({
      'x-dead-letter-routing-key': 'welcome',
    })
  })

  it('retries a failed job via the delay queue, then dead-letters it', async () => {
    const ch = new FakeChannel()
    const driver = driverWith(ch)
    driver.setExecutor(async () => {
      throw new Error('boom')
    })
    driver.startWorker('welcome', { concurrency: 3 })
    await ch.ready
    expect(ch.prefetched).toBe(3)

    // attempt 1 of 2 → re-enqueued to the delay queue as attempt 2, with backoff TTL
    ch.deliver(
      { 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': 1, 'x-basalt-attempts': 2, 'x-basalt-backoff-ms': 1000, 'x-basalt-backoff-type': 'fixed' },
      { name: 'Ada' },
    )
    await tick()
    const retry = ch.sent.find((s) => s.queue === 'welcome.delay')!
    expect(retry).toBeTruthy()
    expect(header(retry, 'x-basalt-attempt')).toBe(2)
    expect(retry.options?.['expiration']).toBe('1000')
    expect(ch.acked).toBe(1)

    // attempt 2 of 2 (final) → dead-lettered
    ch.deliver(
      { 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': 2, 'x-basalt-attempts': 2 },
      { name: 'Ada' },
    )
    await tick()
    expect(ch.sent.find((s) => s.queue === 'welcome.dead')).toBeTruthy()
    expect(ch.acked).toBe(2)
  })

  it('exponential backoff grows with the attempt number', async () => {
    const ch = new FakeChannel()
    const driver = driverWith(ch)
    driver.setExecutor(async () => {
      throw new Error('boom')
    })
    driver.startWorker('welcome')
    await ch.ready

    ch.deliver(
      { 'x-basalt-job': 'j', 'x-basalt-attempt': 3, 'x-basalt-attempts': 5, 'x-basalt-backoff-ms': 1000, 'x-basalt-backoff-type': 'exponential' },
      {},
    )
    await tick()
    const retry = ch.sent.find((s) => s.queue === 'welcome.delay')!
    expect(retry.options?.['expiration']).toBe(String(1000 * 2 ** 2)) // 4000
  })

  it('acks a job that succeeds', async () => {
    const ch = new FakeChannel()
    const driver = driverWith(ch)
    const seen: unknown[] = []
    driver.setExecutor(async (name, data) => {
      seen.push([name, data])
    })
    driver.startWorker('welcome')
    await ch.ready

    ch.deliver({ 'x-basalt-job': 'send-welcome', 'x-basalt-attempt': 1, 'x-basalt-attempts': 1 }, { name: 'Ada' })
    await tick()
    expect(seen).toEqual([['send-welcome', { name: 'Ada' }]])
    expect(ch.acked).toBe(1)
    expect(ch.sent).toHaveLength(0) // no retry, no DLQ
  })
})

describe('crash-safety (Q-2): amqplib error emitters are listened to', () => {
  it('attaches error listeners on connection and channel, wired to onError', async () => {
    const connListeners: ((e: unknown) => void)[] = []
    const chanListeners: ((e: unknown) => void)[] = []
    const channel = new FakeChannel() as FakeChannel & { on?: (e: 'error', l: (err: unknown) => void) => void }
    channel.on = (_e, l) => void chanListeners.push(l)
    const errors: unknown[] = []
    const driver = new RabbitmqQueueDriver({
      url: 'amqp://test',
      onError: (error, info) => void errors.push({ error, info }),
      connect: async () => ({
        on: (_e: 'error', l: (err: unknown) => void) => void connListeners.push(l),
        createChannel: async () => channel,
        close: async () => {},
      }),
    })
    await driver.add('q', 'job', {}, { attempts: 1 })
    expect(connListeners).toHaveLength(1)
    expect(chanListeners).toHaveLength(1)
    const broken = new Error('broker gone')
    connListeners[0]!(broken)
    chanListeners[0]!(new Error('channel torn down'))
    expect(errors).toMatchObject([
      { error: broken, info: { source: 'connection' } },
      { info: { source: 'channel' } },
    ])
  })
})

describe('publisher confirms + graceful shutdown (Q-7)', () => {
  class ConfirmChannel extends FakeChannel {
    confirmWaits = 0
    failConfirms = false
    async waitForConfirms(): Promise<void> {
      this.confirmWaits++
      if (this.failConfirms) throw new Error('nack: broker refused the publish')
    }
  }

  const confirmDriver = (channel: ConfirmChannel, onError?: (e: unknown, i: { source: string }) => void) =>
    new RabbitmqQueueDriver({
      url: 'amqp://test',
      ...(onError ? { onError: onError as never } : {}),
      connect: async () => ({
        createChannel: async () => {
          throw new Error('plain channel must not be used when confirms are available')
        },
        createConfirmChannel: async () => channel,
        close: async () => {},
      }),
    })

  it('prefers a confirm channel when the connection offers one', async () => {
    const ch = new ConfirmChannel()
    await confirmDriver(ch).add('q', 'job', {}, { attempts: 1 })
    expect(ch.sent).toHaveLength(1)
    expect(ch.confirmWaits).toBeGreaterThan(0) // publish awaited broker confirmation
  })

  it('does NOT ack when the retry publish is unconfirmed — the durable copy must survive', async () => {
    const ch = new ConfirmChannel()
    const errors: unknown[] = []
    const driver = confirmDriver(ch, (e) => void errors.push(e))
    driver.setExecutor(async () => {
      throw new Error('handler boom')
    })
    driver.startWorker('q')
    await ch.ready
    ch.failConfirms = true // broker nacks the re-route publish
    ch.deliver({ 'x-basalt-job': 'j', 'x-basalt-attempt': 1, 'x-basalt-attempts': 3 }, {})
    await tick()
    expect(ch.acked).toBe(0) // job-loss window closed: unacked → broker redelivers
    expect(errors.length).toBeGreaterThan(0) // and the failure is observable
  })

  it('close() drains in-flight handlers before tearing the channel down', async () => {
    const ch = new FakeChannel()
    const driver = driverWith(ch)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    driver.setExecutor(async () => gate)
    driver.startWorker('q')
    await ch.ready
    ch.deliver({ 'x-basalt-job': 'j', 'x-basalt-attempt': 1, 'x-basalt-attempts': 1 }, {})
    await tick()
    expect(ch.acked).toBe(0) // still in flight
    const closing = driver.close()
    let closed = false
    void closing.then(() => (closed = true))
    await tick()
    expect(closed).toBe(false) // close waits for the handler
    release()
    await closing
    expect(ch.acked).toBe(1) // the in-flight job finished and acked before close
  })

  it('messages arriving after close() begins are left unacked for redelivery', async () => {
    const ch = new FakeChannel()
    const driver = driverWith(ch)
    const seen: string[] = []
    driver.setExecutor(async (name) => void seen.push(name))
    driver.startWorker('q')
    await ch.ready
    const closing = driver.close()
    ch.deliver({ 'x-basalt-job': 'late', 'x-basalt-attempt': 1, 'x-basalt-attempts': 1 }, {})
    await closing
    await tick()
    expect(seen).toEqual([]) // not processed
    expect(ch.acked).toBe(0) // not acked → broker redelivers elsewhere
  })

  it('a broker-connect failure in startWorker surfaces through onError instead of an unhandled rejection', async () => {
    const errors: { source: string }[] = []
    const driver = new RabbitmqQueueDriver({
      url: 'amqp://down',
      onError: (_e, info) => void errors.push(info),
      connect: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    driver.startWorker('q')
    await tick()
    expect(errors).toMatchObject([{ source: 'connection' }])
  })

  it('an ack that throws (channel torn down) is routed to onError, never an unhandled rejection', async () => {
    const ch = new FakeChannel()
    ch.ack = () => {
      throw new Error('channel closed')
    }
    const errors: unknown[] = []
    const driver = new RabbitmqQueueDriver({
      url: 'amqp://test',
      onError: (e) => void errors.push(e),
      connect: async () => ({ createChannel: async () => ch, close: async () => {} }),
    })
    driver.setExecutor(async () => {})
    driver.startWorker('q')
    await ch.ready
    ch.deliver({ 'x-basalt-job': 'j', 'x-basalt-attempt': 1, 'x-basalt-attempts': 1 }, {})
    await tick()
    expect(errors.length).toBe(1)
    expect(ch.sent).toHaveLength(0) // no publish storm onto the dead channel
  })
})
