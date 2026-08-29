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
    let clock = 0
    const outbox = new Outbox(store, { maxAttempts: 3, now: () => clock })
    await outbox.enqueue('e', {})

    const dispatch = vi.fn(async () => {
      throw new Error('downstream down')
    })

    // three failing flushes (advancing past the retry backoff) exhaust the budget
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    clock += 100_000
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    clock += 100_000
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    clock += 100_000
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

describe('at-least-once hardening (Q-5)', () => {
  it('concurrent flushes coalesce — a slow dispatch cannot double-deliver the same batch', async () => {
    const outbox = new Outbox(new MemoryOutboxStore())
    await outbox.enqueue('invoice.paid', { id: 'in_1' })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const delivered: string[] = []
    const dispatch = async (entry: { payload: unknown }) => {
      delivered.push((entry.payload as { id: string }).id)
      await gate
    }
    const first = outbox.flush(dispatch)
    const second = outbox.flush(dispatch) // overlapping tick
    release()
    const [a, b] = await Promise.all([first, second])
    expect(delivered).toEqual(['in_1']) // exactly once
    expect(a).toEqual({ published: 1, failed: 0 })
    expect(b).toEqual({ published: 1, failed: 0 }) // coalesced onto the in-flight flush
  })

  it('a failed entry backs off instead of being retried on the very next flush', async () => {
    let clock = 0
    const outbox = new Outbox(new MemoryOutboxStore(), {
      now: () => clock,
      backoff: { delayMs: 1000, type: 'exponential' },
    })
    await outbox.enqueue('e', {})
    const dispatch = vi.fn(async () => {
      throw new Error('down')
    })
    expect((await outbox.flush(dispatch)).failed).toBe(1)
    clock = 500 // before the 1s backoff
    await outbox.flush(dispatch)
    expect(dispatch).toHaveBeenCalledTimes(1) // not hammered
    clock = 1001 // past the backoff
    await outbox.flush(dispatch)
    expect(dispatch).toHaveBeenCalledTimes(2)
    clock = 2000 // attempt 2 backs off exponentially (2s from failure at 1001)
    await outbox.flush(dispatch)
    expect(dispatch).toHaveBeenCalledTimes(2)
    clock = 3200
    await outbox.flush(dispatch)
    expect(dispatch).toHaveBeenCalledTimes(3)
  })

  it('surfaces dead entries through onDead when the attempt budget is exhausted', async () => {
    let clock = 0
    const dead: string[] = []
    const outbox = new Outbox(new MemoryOutboxStore(), {
      now: () => clock,
      maxAttempts: 2,
      backoff: { delayMs: 1, type: 'fixed' },
      onDead: (entry) => void dead.push(entry.event),
    })
    await outbox.enqueue('invoice.paid', {})
    const dispatch = async () => {
      throw new Error('down')
    }
    await outbox.flush(dispatch)
    expect(dead).toEqual([]) // still has budget
    clock = 10
    await outbox.flush(dispatch)
    expect(dead).toEqual(['invoice.paid']) // dead-lettered, visibly
    clock = 20
    await outbox.flush(dispatch)
    expect(dead).toEqual(['invoice.paid']) // reported once, not per flush
  })

  it('capture is awaited: a store-write failure surfaces to the emitter instead of dropping the event', async () => {
    const store = new MemoryOutboxStore()
    const broken = Object.create(store) as MemoryOutboxStore
    broken.enqueue = async () => {
      throw new Error('outbox table unavailable')
    }
    const Paid = defineEvent<{ id: string }>('invoice.paid')
    const app = await createApp({
      plugins: [
        eventsPlugin(),
        outboxPlugin({ store: broken, dispatch: async () => {}, captureEvents: ['invoice.*'] }),
      ],
    }).boot()
    const bus = app.container.get(EVENTS)
    await expect(bus.emit(Paid, { id: 'in_1' })).rejects.toThrow(/listener|outbox/i)
    await app.shutdown()
  })
})
