import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata } from '@basaltkit/core'
import { queuePlugin, SyncQueueDriver, type AddJobOptions, type QueueDriver } from '../src/index.js'

/** A driver that supports introspection (like BullMQ). */
class InspectableDriver implements QueueDriver {
  readonly name = 'fake'
  started: { queue: string; concurrency?: number }[] = []
  retryLimit?: number | undefined
  setExecutor(): void {}
  async add(_q: string, _n: string, _d: unknown, _o: AddJobOptions): Promise<void> {}
  startWorker(queue: string, options: { concurrency?: number } = {}): void {
    this.started.push({ queue, ...options })
  }
  async stats() {
    return { waiting: 2, active: 1, completed: 5, failed: 3, delayed: 0 }
  }
  async retryFailed(_queue: string, options: { limit?: number } = {}): Promise<number> {
    this.retryLimit = options.limit
    return 3
  }
  async close(): Promise<void> {}
}

interface Captured {
  logs: string[]
  tables: Record<string, unknown>[][]
}
const fakeIo = (): Captured & { log(m: string): void; table(r: Record<string, unknown>[]): void } => {
  const logs: string[] = []
  const tables: Record<string, unknown>[][] = []
  return { logs, tables, log: (m) => logs.push(m), table: (r) => tables.push(r) }
}

async function commandsOf(driver: QueueDriver) {
  const app = await createApp({ plugins: [queuePlugin({ driver })] }).boot()
  const list = ensureMetadata(app.container).get<{
    name: string
    handle: (ctx: unknown) => Promise<void>
  }>('commands')
  return { app, get: (name: string) => list.find((c) => c.name === name)! }
}

describe('queue CLI commands', () => {
  it('registers queue:work, queue:stats and queue:retry', async () => {
    const { get } = await commandsOf(new InspectableDriver())
    for (const name of ['queue:work', 'queue:stats', 'queue:retry']) expect(get(name)).toBeTruthy()
  })

  it('queue:stats prints the job counts for the queue', async () => {
    const { get } = await commandsOf(new InspectableDriver())
    const io = fakeIo()
    await get('queue:stats').handle({ io, flags: {} } as never)
    expect(io.tables[0]![0]).toMatchObject({ queue: 'default', waiting: 2, failed: 3, completed: 5 })
  })

  it('queue:retry re-enqueues failed jobs and honors --limit', async () => {
    const driver = new InspectableDriver()
    const { get } = await commandsOf(driver)
    const io = fakeIo()
    await get('queue:retry').handle({ io, flags: { queue: 'emails', limit: '50' } } as never)
    expect(driver.retryLimit).toBe(50)
    expect(io.logs[0]).toContain('Re-enqueued 3 failed job(s) on "emails"')
  })

  it('reports unsupported when the driver cannot introspect (sync driver)', async () => {
    const { get } = await commandsOf(new SyncQueueDriver())
    const stats = fakeIo()
    await get('queue:stats').handle({ io: stats, flags: {} } as never)
    expect(stats.logs[0]).toMatch(/Not supported by the active queue driver/)
    const retry = fakeIo()
    await get('queue:retry').handle({ io: retry, flags: {} } as never)
    expect(retry.logs[0]).toMatch(/Not supported/)
    expect(stats.tables).toHaveLength(0)
  })
})
