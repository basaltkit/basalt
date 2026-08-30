import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import {
  defineJob,
  QueueManager,
  readJobEnvelope,
  SyncQueueDriver,
  type AddJobOptions,
  type JobSummary,
  type ListJobsOptions,
  type QueueDriver,
} from '../src/index.js'

/**
 * Gap closed here (2026-08): inspecting *which* jobs are on a queue had no
 * framework API — only `stats()` (counts). Apps reached around the framework
 * straight into BullMQ (`new Queue(...).getJobs(...)`), which re-couples them
 * to one broker and forces them to decode the dispatch envelope by hand.
 * `list()` is the optional-capability sibling of `stats()`/`retryFailed()`.
 */

/** A driver that can list, storing whatever `add` received (like BullMQ does). */
class ListableDriver implements QueueDriver {
  readonly name = 'listable'
  readonly received: { queue: string; name: string; data: unknown }[] = []
  seen?: ListJobsOptions | undefined
  setExecutor(): void {}
  async add(queue: string, name: string, data: unknown, _options: AddJobOptions): Promise<void> {
    this.received.push({ queue, name, data })
  }
  startWorker(): void {}
  async list(_queue: string, options: ListJobsOptions = {}): Promise<JobSummary[]> {
    this.seen = options
    return this.received.map((entry, index) => {
      const { payload, context } = readJobEnvelope(entry.data)
      return {
        id: String(index + 1),
        name: entry.name,
        state: 'completed' as const,
        attemptsMade: 1,
        timestamp: 1_000 + index,
        payload,
        ...(context !== undefined ? { context } : {}),
      }
    })
  }
  async close(): Promise<void> {}
}

describe('QueueManager.list — the optional listing capability', () => {
  it('returns driver-neutral summaries whose payload is the app data, not the envelope', async () => {
    const driver = new ListableDriver()
    const manager = new QueueManager(driver)
    const job = defineJob({ name: 'email.welcome', queue: 'emails', handle: () => {} })
    manager.register(job)

    await runWithContext({ requestId: 'req-7', tenant: { id: 'acme' } }, () =>
      job.dispatch({ userId: 'u-1' }),
    )

    const jobs = await manager.list('emails')
    expect(jobs).toHaveLength(1)
    const [first] = jobs!
    // The app's payload — NOT `{ payload, context }`, and not a BullMQ Job.
    expect(first!.payload).toEqual({ userId: 'u-1' })
    expect(first!.context).toMatchObject({ requestId: 'req-7' })
    expect(first).toMatchObject({ name: 'email.welcome', state: 'completed', attemptsMade: 1 })
    expect(first!.timestamp).toBeTypeOf('number')
  })

  it('passes states/limit through to the driver', async () => {
    const driver = new ListableDriver()
    const manager = new QueueManager(driver)
    await manager.list('emails', { states: ['failed'], limit: 5 })
    expect(driver.seen).toEqual({ states: ['failed'], limit: 5 })
  })

  it('returns undefined (honest "unsupported") on a driver that cannot list', async () => {
    const manager = new QueueManager(new SyncQueueDriver())
    await expect(manager.list('default')).resolves.toBeUndefined()
  })
})

describe('readJobEnvelope', () => {
  it('unwraps a dispatch envelope', () => {
    expect(readJobEnvelope({ payload: { a: 1 }, context: { requestId: 'r' } })).toEqual({
      payload: { a: 1 },
      context: { requestId: 'r' },
    })
  })

  it('treats anything that is not an envelope as the payload itself', () => {
    // Jobs enqueued by an older version, or by a non-Basalt producer.
    expect(readJobEnvelope({ a: 1 })).toEqual({ payload: { a: 1 } })
    expect(readJobEnvelope('raw')).toEqual({ payload: 'raw' })
    expect(readJobEnvelope(null)).toEqual({ payload: null })
  })
})
