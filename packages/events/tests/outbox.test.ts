import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@basaltkit/core'
import { defineEvent, eventsPlugin, EVENTS } from '../src/index.js'
import { MemoryOutboxStore, Outbox, OUTBOX, outboxPlugin } from '../src/index.js'

describe('Outbox', () => {
  it('publishes pending entries and marks them delivered', async () => {
    const clock = 1000
    const outbox = new Outbox(new MemoryOutboxStore(), { now: () => clock })
    await outbox.enqueue('invoice.paid', { id: 'in_1' }, 'acme')
    await outbox.enqueue('invoice.paid', { id: 'in_2' })

    const delivered: string[] = []
    const result = await outbox.flush(async (entry) => {
      delivered.push((entry.payload as { id: string }).id)
    })

    expect(result).toEqual({ published: 2, failed: 0 })
    expect(delivered).toEqual(['in_1', 'in_2'])
    // already published → nothing left to flush
    expect((await outbox.flush(async () => {})).published).toBe(0)
  })

  it('retries failures up to maxAttempts, then leaves them dead', async () => {
    const store = new MemoryOutboxStore()
    const outbox = new Outbox(store, { maxAttempts: 3 })
    await outbox.enqueue('e', {})

    const dispatch = vi.fn(async () => {
      throw new Error('downstream down')
    })

    // three failing flushes exhaust the budget
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    // now dead — no longer picked up
    expect((await outbox.flush(dispatch)).failed).toBe(0)
    expect(dispatch).toHaveBeenCalledTimes(3)

    const [entry] = await store.all()
    expect(entry!.attempts).toBe(3)
    expect(entry!.lastError).toContain('downstream down')
    expect(entry!.publishedAt).toBeUndefined()
  })

  it('preserves FIFO order by createdAt', async () => {
    let clock = 0
    const outbox = new Outbox(new MemoryOutboxStore(), { now: () => clock })
    clock = 30
    await outbox.enqueue('c', {})
    clock = 10
    await outbox.enqueue('a', {})
    clock = 20
    await outbox.enqueue('b', {})
    const order: string[] = []
    await outbox.flush(async (e) => void order.push(e.event))
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('outboxPlugin', () => {
  it('captures domain events into the outbox, tenant-scoped', async () => {
    const store = new MemoryOutboxStore()
    const app = await createApp({
      plugins: [eventsPlugin(), outboxPlugin({ store, dispatch: async () => {}, captureEvents: ['invoice.*'] })],
    }).boot()

    const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
    await app.container.get(EVENTS).emit(InvoicePaid, { amount: 5 })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const entries = await store.all()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.event).toBe('invoice.paid')
    expect(entries[0]!.payload).toEqual({ amount: 5 })

    // OUTBOX is resolvable for manual flush
    const delivered: string[] = []
    await app.container.get(OUTBOX).flush(async (e) => void delivered.push(e.event))
    expect(delivered).toEqual(['invoice.paid'])
    await app.shutdown()
  })
})
