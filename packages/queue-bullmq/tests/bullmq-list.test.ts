import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { JobState } from '@basaltkit/queue'

/**
 * `BullmqQueueDriver.list` — the only driver that can list jobs, because Redis
 * keeps them: reading is non-destructive. The driver must return driver-neutral
 * summaries (never a BullMQ `Job`) with the payload unwrapped from the envelope.
 */

interface FakeJob {
  id: string
  name: string
  data: unknown
  attemptsMade: number
  timestamp: number
  failedReason?: string
}

/** Jobs per state, and the (types, start, end) each getJobs call asked for. */
const store: Record<string, FakeJob[]> = {}
const calls: { types: string[]; start: number; end: number }[] = []

class FakeQueue extends EventEmitter {
  constructor(
    readonly queueName: string,
    readonly opts: unknown,
  ) {
    super()
  }
  async getJobs(types: string[], start: number, end: number): Promise<(FakeJob | undefined)[]> {
    calls.push({ types, start, end })
    return (store[types[0]!] ?? []).slice(start, end + 1)
  }
  async add(): Promise<void> {}
  async close(): Promise<void> {}
}
class FakeWorker extends EventEmitter {
  async close(): Promise<void> {}
}

vi.mock('bullmq', () => ({ Worker: FakeWorker, Queue: FakeQueue }))

const { BullmqQueueDriver } = await import('../src/index.js')
const driver = () => new BullmqQueueDriver({ connection: 'redis://localhost:6379' })

const job = (over: Partial<FakeJob> & { id: string; timestamp: number }): FakeJob => ({
  name: 'email.welcome',
  data: { payload: { userId: `u-${over.id}` }, context: { requestId: `req-${over.id}` } },
  attemptsMade: 1,
  ...over,
})

const reset = (seed: Record<string, FakeJob[]>) => {
  for (const key of Object.keys(store)) delete store[key]
  Object.assign(store, seed)
  calls.length = 0
}

describe('BullmqQueueDriver.list', () => {
  it('returns neutral summaries with the payload unwrapped from the envelope', async () => {
    reset({ completed: [job({ id: '1', timestamp: 1000 })] })
    const [summary] = await driver().list('emails')
    expect(summary).toEqual({
      id: '1',
      name: 'email.welcome',
      state: 'completed',
      attemptsMade: 1,
      timestamp: 1000,
      payload: { userId: 'u-1' },
      context: { requestId: 'req-1' },
    })
    // No BullMQ Job leaked through: only the documented keys are present.
    expect(Object.keys(summary!).sort()).toEqual(
      ['attemptsMade', 'context', 'id', 'name', 'payload', 'state', 'timestamp'].sort(),
    )
  })

  it("defaults to completed+failed+waiting+active — a healthy queue's jobs are in completed", async () => {
    reset({ completed: [job({ id: '1', timestamp: 1000 })] })
    const jobs = await driver().list('emails')
    expect(calls.map((c) => c.types[0])).toEqual(['completed', 'failed', 'waiting', 'active'])
    expect(calls.every((c) => c.end === 19)).toBe(true) // default limit 20
    expect(jobs).toHaveLength(1)
  })

  it('merges states newest-first and caps the TOTAL at `limit`', async () => {
    reset({
      completed: [job({ id: 'c1', timestamp: 100 }), job({ id: 'c2', timestamp: 400 })],
      failed: [job({ id: 'f1', timestamp: 300, failedReason: 'boom' })],
      waiting: [job({ id: 'w1', timestamp: 500 })],
      active: [],
    })
    const jobs = await driver().list('emails', { limit: 3 })
    expect(jobs.map((j) => j.id)).toEqual(['w1', 'c2', 'f1'])
    expect(jobs.find((j) => j.id === 'f1')).toMatchObject({ state: 'failed', failedReason: 'boom' })
  })

  it('honors explicit states, de-duplicated', async () => {
    reset({ failed: [job({ id: 'f1', timestamp: 1 })] })
    await driver().list('emails', { states: ['failed', 'failed'] as JobState[], limit: 5 })
    expect(calls).toEqual([{ types: ['failed'], start: 0, end: 4 }])
  })

  it('clamps limit to the hard ceiling so inspection never becomes a full scan', async () => {
    reset({ completed: [] })
    await driver().list('emails', { states: ['completed'], limit: 10_000 })
    expect(calls[0]!.end).toBe(999) // MAX_LIST_LIMIT = 1000
  })

  it('survives holes and non-envelope data (older producers, hand-written jobs)', async () => {
    reset({
      completed: [
        undefined as unknown as FakeJob,
        { id: '9', name: 'legacy', data: { userId: 'raw' }, attemptsMade: 0, timestamp: 5 },
      ],
    })
    const jobs = await driver().list('emails', { states: ['completed'] })
    expect(jobs).toEqual([
      { id: '9', name: 'legacy', state: 'completed', attemptsMade: 0, timestamp: 5, payload: { userId: 'raw' } },
    ])
  })
})
