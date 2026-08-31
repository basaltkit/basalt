import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

/**
 * The BullMQ driver's crash-safety hooks (`onError`/`onJobFailed`, queue 1.3.0)
 * must survive the one-line plugin path. They were once dead code there: the
 * old `queuePlugin({ connection })` shorthand built the driver itself and
 * dropped the callbacks, which `QueuePluginOptions` did not even accept. The
 * plugin now lives in this package, beside the driver it configures, so the
 * two cannot drift apart again — but the hooks still reach it through a
 * wrapper, and a wrapper is exactly where options get silently forgotten.
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

const { createApp } = await import('@basaltkit/core')
const { QUEUE } = await import('@basaltkit/queue')
const { bullmqQueuePlugin } = await import('../src/index.js')

beforeEach(() => {
  FakeWorker.instances = []
  FakeQueue.instances = []
})

describe('bullmqQueuePlugin forwards the driver observability hooks', () => {
  it("routes a worker 'error' to the plugin-level onError", async () => {
    const errors: { error: unknown; info: { queue: string; source: string } }[] = []
    const app = await createApp({
      plugins: [
        bullmqQueuePlugin({
          connection: 'redis://localhost:6379',
          workers: [{ queue: 'emails' }],
          onError: (error, info) => void errors.push({ error, info }),
        }),
      ],
    })
    await app.boot()

    const worker = FakeWorker.instances[0]
    expect(worker).toBeDefined()
    const redisDown = new Error('ECONNREFUSED')
    expect(() => worker!.emit('error', redisDown)).not.toThrow()
    expect(errors).toMatchObject([
      { error: redisDown, info: { queue: 'emails', source: 'worker' } },
    ])
  })

  it("routes an exhausted job ('failed') to the plugin-level onJobFailed", async () => {
    const dead: { queue: string; job: string; jobId?: string }[] = []
    const app = await createApp({
      plugins: [
        bullmqQueuePlugin({
          connection: 'redis://localhost:6379',
          workers: [{ queue: 'emails' }],
          onJobFailed: (info) => void dead.push(info),
        }),
      ],
    })
    await app.boot()

    const worker = FakeWorker.instances[0]!
    worker.emit('failed', { id: 'j1', name: 'send-email' }, new Error('boom'))
    expect(dead).toMatchObject([{ queue: 'emails', job: 'send-email', jobId: 'j1' }])
  })

  it("routes a producer-side Queue 'error' to onError too", async () => {
    const errors: { info: { source: string } }[] = []
    const app = await createApp({
      plugins: [
        bullmqQueuePlugin({
          connection: 'redis://localhost:6379',
          onError: (error, info) => void errors.push({ info }),
        }),
      ],
    })
    await app.boot()
    // Touch the producer path so the underlying Queue is constructed.
    await app.container.get(QUEUE).stats('emails').catch(() => undefined)
    const queue = FakeQueue.instances[0]!
    expect(queue).toBeDefined()
    expect(() => queue.emit('error', new Error('ECONNREFUSED'))).not.toThrow()
    expect(errors).toMatchObject([{ info: { source: 'queue' } }])
  })
})
