import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Q-2 (review 2026-08-b): BullMQ's Worker and Queue are EventEmitters; an
 * emitted 'error' with no listener THROWS (and uncaught, crashes the process),
 * and without a 'failed' listener exhausted jobs vanish silently. The driver
 * must attach both, wired to an observable path (same style as realtime's
 * onBridgeError).
 */

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = []
  constructor(
    readonly queueName: string,
    readonly processor: (job: { name: string; data: unknown }) => Promise<unknown>,
    readonly opts: unknown,
  ) {
    super()
    FakeWorker.instances.push(this)
  }
  async close(): Promise<void> {}
}

class FakeQueue extends EventEmitter {
  static instances: FakeQueue[] = []
  static getFailedCalls: [number, number][] = []
  constructor(readonly queueName: string, readonly opts: unknown) {
    super()
    FakeQueue.instances.push(this)
  }
  async add(): Promise<void> {}
  async getFailed(start: number, end: number): Promise<{ retry(): Promise<void> }[]> {
    FakeQueue.getFailedCalls.push([start, end])
    // BullMQ semantics: end -1 means "to the end" — every failed job.
    const all = Array.from({ length: 5 }, () => ({ async retry() {} }))
    return end < 0 ? all : all.slice(start, end + 1)
  }
  async close(): Promise<void> {}
}

vi.mock('bullmq', () => ({ Worker: FakeWorker, Queue: FakeQueue }))

const { BullmqQueueDriver } = await import('../src/index.js')

beforeEach(() => {
  FakeWorker.instances = []
  FakeQueue.instances = []
  FakeQueue.getFailedCalls = []
})

describe('BullMQ driver crash-safety and failure visibility', () => {
  it("an emitted worker 'error' no longer crashes — it reaches onError", () => {
    const errors: unknown[] = []
    const driver = new BullmqQueueDriver({
      connection: 'redis://localhost:6379',
      onError: (error, info) => void errors.push({ error, info }),
    })
    driver.startWorker('emails')
    const worker = FakeWorker.instances[0]!
    const redisDown = new Error('ECONNREFUSED')
    // Node EventEmitter semantics: 'error' with no listener THROWS. Pre-fix
    // this line detonated; post-fix the driver's listener absorbs it.
    expect(() => worker.emit('error', redisDown)).not.toThrow()
    expect(errors).toMatchObject([{ error: redisDown, info: { queue: 'emails', source: 'worker' } }])
  })

  it("a Queue 'error' (producer-side Redis fault) is absorbed and reported too", async () => {
    const errors: unknown[] = []
    const driver = new BullmqQueueDriver({
      connection: 'redis://localhost:6379',
      onError: (error, info) => void errors.push({ error, info }),
    })
    await driver.add('emails', 'send', {}, { attempts: 1 })
    const queue = FakeQueue.instances[0]!
    expect(() => queue.emit('error', new Error('redis gone'))).not.toThrow()
    expect(errors).toMatchObject([{ info: { queue: 'emails', source: 'queue' } }])
  })

  it('a job exhausting retries reaches onJobFailed instead of vanishing', () => {
    const failed: unknown[] = []
    const driver = new BullmqQueueDriver({
      connection: 'redis://localhost:6379',
      onJobFailed: (info) => void failed.push(info),
    })
    driver.startWorker('emails')
    const boom = new Error('handler blew up')
    FakeWorker.instances[0]!.emit('failed', { name: 'send', id: '42', attemptsMade: 3 }, boom)
    expect(failed).toMatchObject([{ queue: 'emails', job: 'send', jobId: '42', error: boom }])
  })

  it('defaults are observable, not silent: console.error carries the context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const driver = new BullmqQueueDriver({ connection: 'redis://localhost:6379' })
    driver.startWorker('emails')
    FakeWorker.instances[0]!.emit('error', new Error('x'))
    FakeWorker.instances[0]!.emit('failed', { name: 'send', id: '1', attemptsMade: 2 }, new Error('y'))
    expect(spy).toHaveBeenCalledTimes(2)
    expect(String(spy.mock.calls[0])).toContain('[basalt:queue]')
    spy.mockRestore()
  })
})

describe('BullMQ driver capabilities', () => {
  // Moved here from the core's queue.test.ts when the driver was extracted:
  // @basaltkit/queue no longer knows any concrete backend, so each driver
  // package asserts the contract it claims to honour.
  it('declares the full set — BullMQ supports every optional capability', () => {
    expect(new BullmqQueueDriver({ connection: 'redis://localhost:6379' }).capabilities).toEqual({
      delayed: true,
      priority: true,
      retries: true,
      backoff: true,
    })
  })

  it('identifies itself as "bullmq" for diagnostics', () => {
    expect(new BullmqQueueDriver({ connection: 'redis://localhost:6379' }).name).toBe('bullmq')
  })
})

describe('FA-064 / FA-066: BullMQ failure reporting, retry limits, credentials', () => {
  it('onJobFailed fires once, on the FINAL failure — not on attempts BullMQ will retry', () => {
    const failed: unknown[] = []
    const driver = new BullmqQueueDriver({
      connection: 'redis://localhost:6379',
      onJobFailed: (info) => void failed.push(info),
    })
    driver.startWorker('emails')
    const worker = FakeWorker.instances[0]!
    // BullMQ emits 'failed' after every attempt, with attemptsMade already incremented.
    worker.emit('failed', { name: 'send', id: '1', attemptsMade: 1, opts: { attempts: 3 } }, new Error('a1'))
    worker.emit('failed', { name: 'send', id: '1', attemptsMade: 2, opts: { attempts: 3 } }, new Error('a2'))
    expect(failed).toHaveLength(0)
    worker.emit('failed', { name: 'send', id: '1', attemptsMade: 3, opts: { attempts: 3 } }, new Error('a3'))
    expect(failed).toMatchObject([{ jobId: '1' }])
  })

  it('an UnrecoverableError is final even with attempts left', () => {
    const failed: unknown[] = []
    const driver = new BullmqQueueDriver({
      connection: 'redis://localhost:6379',
      onJobFailed: (info) => void failed.push(info),
    })
    driver.startWorker('emails')
    const fatal = Object.assign(new Error('bad input'), { name: 'UnrecoverableError' })
    FakeWorker.instances[0]!.emit('failed', { name: 'send', id: '2', attemptsMade: 1, opts: { attempts: 5 } }, fatal)
    expect(failed).toHaveLength(1)
  })

  it.each([0, -3, Number.NaN])('retryFailed with limit %s retries nothing (it used to retry EVERY failed job)', async (limit) => {
    const driver = new BullmqQueueDriver({ connection: 'redis://localhost:6379' })
    await expect(driver.retryFailed('emails', { limit })).resolves.toBe(0)
    expect(FakeQueue.getFailedCalls).toEqual([])
  })

  it('retryFailed with a positive limit still asks for exactly that many', async () => {
    const driver = new BullmqQueueDriver({ connection: 'redis://localhost:6379' })
    await expect(driver.retryFailed('emails', { limit: 2 })).resolves.toBe(2)
    expect(FakeQueue.getFailedCalls).toEqual([[0, 1]])
  })

  it('percent-encoded credentials in the Redis URL are decoded before reaching ioredis', () => {
    const driver = new BullmqQueueDriver({ connection: 'redis://ops%40acme:p%40ss%3Aw%2Frd@cache:6379' })
    driver.startWorker('emails')
    expect((FakeWorker.instances[0]!.opts as { connection: unknown }).connection).toMatchObject({
      username: 'ops@acme',
      password: 'p@ss:w/rd',
    })
  })
})
