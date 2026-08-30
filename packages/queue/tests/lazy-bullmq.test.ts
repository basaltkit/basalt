import { describe, expect, it, vi } from 'vitest'

/**
 * `@basaltkit/queue` is the *driver-agnostic* core, but `src/index.ts` used to
 * statically re-export `./drivers/bullmq.js`, which imports `bullmq` at module
 * scope. Importing the barrel therefore loaded BullMQ (and its ioredis
 * transitive weight) even for an app running on SQS/RabbitMQ/Kafka/sync — the
 * exact coupling the satellite driver packages avoid with optional peers.
 *
 * The probe is the mock factory below: Vitest evaluates it ONLY when something
 * actually imports 'bullmq', so `loaded` is a faithful witness of the load.
 * Test order matters here — the flag is module-global and latches.
 */
const bullmq = vi.hoisted(() => ({ loaded: false }))

vi.mock('bullmq', async () => {
  bullmq.loaded = true
  const { EventEmitter } = await import('node:events')
  class FakeQueue extends EventEmitter {
    constructor(
      readonly queueName: string,
      readonly opts: unknown,
    ) {
      super()
    }
    async add(): Promise<void> {}
    async close(): Promise<void> {}
  }
  class FakeWorker extends EventEmitter {
    constructor(
      readonly queueName: string,
      readonly processor: unknown,
      readonly opts: unknown,
    ) {
      super()
    }
    async close(): Promise<void> {}
  }
  return { Queue: FakeQueue, Worker: FakeWorker }
})

describe('bullmq is loaded only when it is the chosen driver', () => {
  it('importing the barrel does not load bullmq', async () => {
    const mod = await import('../src/index.js')
    expect(mod.queuePlugin).toBeTypeOf('function')
    expect(bullmq.loaded).toBe(false)
  })

  it('the sync path (no connection) boots without loading bullmq', async () => {
    const { createApp } = await import('@basaltkit/core')
    const { QUEUE, queuePlugin } = await import('../src/index.js')
    const app = await createApp({ plugins: [queuePlugin({})] }).boot()
    // Force the singleton factory to run — that is where the driver is built.
    expect(app.container.get(QUEUE)).toBeDefined()
    await app.shutdown()
    expect(bullmq.loaded).toBe(false)
  })

  it('queuePlugin({ connection }) does load it (the shorthand still works)', async () => {
    const { createApp } = await import('@basaltkit/core')
    const { QUEUE, queuePlugin } = await import('../src/index.js')
    const app = await createApp({
      plugins: [queuePlugin({ connection: 'redis://localhost:6379' })],
    }).boot()
    expect(app.container.get(QUEUE)).toBeDefined()
    await app.shutdown()
    expect(bullmq.loaded).toBe(true)
  })
})
