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
  constructor(readonly queueName: string, readonly opts: unknown) {
    super()
    FakeQueue.instances.push(this)
  }
  async add(): Promise<void> {}
  async close(): Promise<void> {}
}

vi.mock('bullmq', () => ({ Worker: FakeWorker, Queue: FakeQueue }))

const { BullmqQueueDriver } = await import('../src/drivers/bullmq.js')

beforeEach(() => {
  FakeWorker.instances = []
  FakeQueue.instances = []
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
