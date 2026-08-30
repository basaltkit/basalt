import { describe, expect, it } from 'vitest'
import { createApp, ensureMetadata } from '@basaltkit/core'
import {
  queuePlugin,
  SyncQueueDriver,
  type AddJobOptions,
  type JobSummary,
  type ListJobsOptions,
  type QueueDriver,
} from '../src/index.js'

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
  listOptions?: ListJobsOptions | undefined
  jobs: JobSummary[] = [
    {
      id: '1',
      name: 'email.welcome',
      state: 'completed',
      attemptsMade: 1,
      timestamp: Date.now() - 5_000,
      payload: { email: 'ana@example.com' },
    },
  ]
  async list(_queue: string, options: ListJobsOptions = {}): Promise<JobSummary[]> {
    this.listOptions = options
    return this.jobs
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
  it('registers queue:work, queue:stats, queue:retry and queue:jobs', async () => {
    const { get } = await commandsOf(new InspectableDriver())
    for (const name of ['queue:work', 'queue:stats', 'queue:retry', 'queue:jobs'])
      expect(get(name)).toBeTruthy()
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

  it('queue:jobs lists jobs and hides payloads unless --payload is passed', async () => {
    const driver = new InspectableDriver()
    const { get } = await commandsOf(driver)

    const io = fakeIo()
    await get('queue:jobs').handle({ io, flags: { queue: 'emails' } } as never)
    expect(driver.listOptions).toEqual({})
    expect(io.tables[0]![0]).toMatchObject({ id: '1', name: 'email.welcome', state: 'completed', attempts: 1 })
    // A payload can carry personal data — never printed without the opt-in.
    expect(io.tables[0]![0]).not.toHaveProperty('payload')
    expect(JSON.stringify(io.tables[0])).not.toContain('ana@example.com')
    expect(io.logs[0]).toContain('--payload')

    const opted = fakeIo()
    await get('queue:jobs').handle({ io: opted, flags: { payload: true } } as never)
    expect(opted.tables[0]![0]!['payload']).toContain('ana@example.com')
    expect(opted.logs[0]).toContain('can contain personal data')
  })

  it('queue:jobs honors --states/--limit and rejects an unknown state', async () => {
    const driver = new InspectableDriver()
    const { get } = await commandsOf(driver)
    await get('queue:jobs').handle({ io: fakeIo(), flags: { states: 'failed, delayed', limit: '5' } } as never)
    expect(driver.listOptions).toEqual({ states: ['failed', 'delayed'], limit: 5 })

    await expect(
      get('queue:jobs').handle({ io: fakeIo(), flags: { states: 'exploded' } } as never),
    ).rejects.toThrow(/Unknown job state\(s\): exploded/)
  })

  it('queue:jobs renders ages compactly and never breaks on an odd payload', async () => {
    const driver = new InspectableDriver()
    const now = Date.now()
    const circular: Record<string, unknown> = { ok: true }
    circular['self'] = circular // JSON.stringify throws — the table must still render
    driver.jobs = (
      [
        [now - 90_000, { ok: true }],
        [now - 7_200_000, { note: 'a'.repeat(200) }],
        [now - 3 * 86_400_000, circular],
      ] as [number, unknown][]
    ).map(([timestamp, payload], index) => ({
      id: String(index),
      name: 'j',
      state: 'completed' as const,
      attemptsMade: 0,
      timestamp,
      payload,
    }))
    const { get } = await commandsOf(driver)
    const io = fakeIo()
    await get('queue:jobs').handle({ io, flags: { payload: true } } as never)
    expect(io.tables[0]!.map((row) => row['age'])).toEqual(['2m', '2h', '3d'])
    expect(String(io.tables[0]![0]!['payload'])).toBe('{"ok":true}')
    // Long payloads are capped to one cell; an unserializable one degrades, never throws.
    expect(String(io.tables[0]![1]!['payload'])).toHaveLength(120)
    expect(String(io.tables[0]![2]!['payload'])).toBe('[object Object]')
  })

  it('queue:jobs says so when the queue is empty instead of printing an empty table', async () => {
    const driver = new InspectableDriver()
    driver.jobs = []
    const { get } = await commandsOf(driver)
    const io = fakeIo()
    await get('queue:jobs').handle({ io, flags: { queue: 'emails' } } as never)
    expect(io.tables).toHaveLength(0)
    expect(io.logs[0]).toBe('No jobs on "emails" in completed, failed, waiting, active.')
  })

  it('reports unsupported when the driver cannot introspect (sync driver)', async () => {
    const { get } = await commandsOf(new SyncQueueDriver())
    const stats = fakeIo()
    await get('queue:stats').handle({ io: stats, flags: {} } as never)
    expect(stats.logs[0]).toMatch(/Not supported by the active queue driver/)
    const retry = fakeIo()
    await get('queue:retry').handle({ io: retry, flags: {} } as never)
    expect(retry.logs[0]).toMatch(/Not supported/)
    const jobs = fakeIo()
    await get('queue:jobs').handle({ io: jobs, flags: {} } as never)
    expect(jobs.logs[0]).toMatch(/listing jobs needs a backend that can read a job WITHOUT consuming it/)
    expect(jobs.logs[0]).toMatch(/RabbitMQ\/SQS\/Kafka/)
    expect(jobs.tables).toHaveLength(0)
    expect(stats.tables).toHaveLength(0)
  })
})
