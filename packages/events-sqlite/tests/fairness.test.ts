import { describe, expect, it } from 'vitest'
import { Outbox, type OutboxEntry } from '@basaltkit/events'
import { openOutboxDatabase, SqliteOutboxStore } from '../src/index.js'

/**
 * SECURITY INVARIANT (availability, F68) over the durable store: a tenant whose
 * downstream hangs, with a backlog larger than a batch, cannot starve another
 * tenant — the relay looks past it with the store's tenant filter.
 */
describe('Outbox fairness over SqliteOutboxStore', () => {
  it('delivers another tenant behind a hanging tenant\'s larger-than-batch backlog', async () => {
    let clock = 0
    const outbox = new Outbox(new SqliteOutboxStore(openOutboxDatabase()), { now: () => clock, dispatchTimeoutMs: 10 })
    for (let i = 0; i < 80; i++) {
      clock += 1
      await outbox.enqueue('a.event', { i }, 'tenant-a')
    }
    clock += 1
    await outbox.enqueue('b.event', { id: 'b1' }, 'tenant-b')
    await outbox.enqueue('g.event', { id: 'g1' })

    const delivered: string[] = []
    const result = await outbox.flush(async (entry: OutboxEntry) => {
      if (entry.tenantId === 'tenant-a') return new Promise<void>(() => {})
      delivered.push((entry.payload as { id: string }).id)
    }, 20)
    expect(delivered.sort()).toEqual(['b1', 'g1'])
    expect(result.published).toBe(2)
  })
})
