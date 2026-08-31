import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `bullmqQueuePlugin` splits its options in two — the CORE's keys go to
 * `queuePlugin`, everything else goes to the driver — and a split like that is
 * where options get silently dropped. That is not hypothetical: the shorthand
 * this plugin replaces did exactly that to `onError`/`onJobFailed` for two
 * minor versions, and nothing failed.
 *
 * So both halves are asserted here on ONE boot: a core key (`jobs`, `workers`,
 * `removeOnComplete`) reaching the manager, and a driver key (`connection`)
 * reaching the driver. A future option added to either side is only safe if it
 * gains a line here too.
 */

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = []
  constructor(
    readonly queueName: string,
    readonly processor: (job: { name: string; data: unknown }) => Promise<unknown>,
    readonly opts: { concurrency?: number; connection?: unknown },
  ) {
    super()
    FakeWorker.instances.push(this)
  }
  async close(): Promise<void> {}
}

class FakeQueue extends EventEmitter {
  static instances: FakeQueue[] = []
  static added: { name: string; data: unknown; opts: Record<string, unknown> }[] = []
  constructor(readonly queueName: string, readonly opts: { connection?: unknown }) {
    super()
    FakeQueue.instances.push(this)
  }
  async add(name: string, data: unknown, opts: Record<string, unknown>): Promise<void> {
    FakeQueue.added.push({ name, data, opts })
  }
  async close(): Promise<void> {}
}

vi.mock('bullmq', () => ({ Worker: FakeWorker, Queue: FakeQueue }))

const { createApp } = await import('@basaltkit/core')
const { QUEUE, defineJob } = await import('@basaltkit/queue')
const { bullmqQueuePlugin } = await import('../src/index.js')

beforeEach(() => {
  FakeWorker.instances = []
  FakeQueue.instances = []
  FakeQueue.added = []
})

const SendWelcome = defineJob({ name: 'send-welcome', queue: 'welcome', handle: () => {} })

describe('bullmqQueuePlugin forwards both halves of its options', () => {
  it('sends the core keys to queuePlugin and the driver keys to the driver', async () => {
    const app = await createApp({
      plugins: [
        bullmqQueuePlugin({
          connection: 'redis://user:secret@cache.internal:6380/2',
          jobs: [SendWelcome],
          workers: [{ queue: 'welcome', concurrency: 7 }],
          removeOnComplete: 25,
        }),
      ],
    })
    await app.boot()

    // CORE half — `workers` started a worker, with `concurrency` intact.
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0]!.queueName).toBe('welcome')
    expect(FakeWorker.instances[0]!.opts.concurrency).toBe(7)

    // CORE half — `jobs` registered it, so dispatch resolves and reaches Redis.
    await app.container.get(QUEUE).dispatch(SendWelcome, undefined)
    expect(FakeQueue.added).toHaveLength(1)
    expect(FakeQueue.added[0]!.name).toBe('send-welcome')
    // CORE half — `removeOnComplete` survived manager → driver → BullMQ options.
    expect(FakeQueue.added[0]!.opts['removeOnComplete']).toBe(25)

    // DRIVER half — `connection` was parsed and handed to BullMQ, not dropped.
    expect(FakeQueue.instances[0]!.opts.connection).toMatchObject({
      host: 'cache.internal',
      port: 6380,
      username: 'user',
      password: 'secret',
      db: 2,
    })

    await app.shutdown()
  })

  it('omitting every optional key still boots — on the sync-free BullMQ path', async () => {
    // `connection` is the only required option; nothing else may become
    // mandatory by accident through the wrapper's destructuring.
    const app = await createApp({
      plugins: [bullmqQueuePlugin({ connection: 'redis://localhost:6379' })],
    })
    await app.boot()
    expect(FakeWorker.instances).toHaveLength(0)
    expect(app.container.get(QUEUE)).toBeDefined()
    await app.shutdown()
  })
})
