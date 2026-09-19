import { describe, expect, it } from 'vitest'
import { MemoryOutboxStore, Outbox, type OutboxEntry, type OutboxStore } from '../src/index.js'

/**
 * SECURITY INVARIANT (availability, F68): one tenant whose downstream hangs —
 * however many events it emits — cannot starve other tenants' outbox entries.
 * Another tenant's entries are selected even behind a larger-than-batch backlog,
 * are dispatched without waiting for the hanging ones, and every flush returns
 * within a bounded time so the relay keeps ticking.
 */

const never = new Promise<void>(() => {})
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** Rejects if `promise` has not settled within `ms` — turns a stalled relay into a failure. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('outbox tenant fairness (F68 residual)', () => {
  it('a hanging tenant with a larger-than-batch backlog cannot starve another tenant', async () => {
    let clock = 0
    const outbox = new Outbox(new MemoryOutboxStore(), { now: () => clock, dispatchTimeoutMs: 20 })
    // Tenant A has flooded the outbox with more entries than one batch holds,
    // all OLDER than tenant B's.
    for (let i = 0; i < 120; i++) {
      clock += 1
      await outbox.enqueue('a.event', { i }, 'tenant-a')
    }
    clock += 1
    await outbox.enqueue('b.event', { id: 'b1' }, 'tenant-b')
    await outbox.enqueue('b.event', { id: 'b2' }, 'tenant-b')

    const delivered: string[] = []
    const dispatch = async (entry: OutboxEntry) => {
      if (entry.tenantId === 'tenant-a') return never // A's endpoint hangs
      delivered.push((entry.payload as { id: string }).id)
    }

    // Each flush must return (bounded barrier) and B must be through within
    // the first flush — not after A's backlog drains.
    const first = await within(outbox.flush(dispatch, 50), 1000, 'first flush')
    expect(delivered.sort()).toEqual(['b1', 'b2'])
    expect(first.published).toBe(2)

    // A keeps emitting; B's next event is still delivered on the next tick.
    for (let i = 0; i < 50; i++) {
      clock += 1
      await outbox.enqueue('a.event', { i }, 'tenant-a')
    }
    clock += 1
    await outbox.enqueue('b.event', { id: 'b3' }, 'tenant-b')
    await within(outbox.flush(dispatch, 50), 1000, 'second flush')
    expect(delivered).toContain('b3')
  })

  it('caps a tenant\'s in-flight dispatches across flushes (tenantConcurrency)', async () => {
    const outbox = new Outbox(new MemoryOutboxStore(), { dispatchTimeoutMs: 5, concurrency: 8, tenantConcurrency: 2 })
    for (let i = 0; i < 20; i++) await outbox.enqueue('a.event', { i }, 'tenant-a')
    let started = 0
    const dispatch = async () => {
      started += 1
      return never
    }
    for (let i = 0; i < 5; i++) await within(outbox.flush(dispatch), 1000, `flush ${i}`)
    // The two hung dispatches are still in flight: nothing more of A starts.
    expect(started).toBe(2)
  })

  it('a detached (timed-out) dispatch is not re-dispatched while in flight, and its late outcome is recorded', async () => {
    const store = new MemoryOutboxStore()
    const outbox = new Outbox(store, { dispatchTimeoutMs: 5 })
    await outbox.enqueue('slow', {}, 'tenant-a')
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    const dispatch = async () => {
      calls += 1
      await gate
    }
    const first = await within(outbox.flush(dispatch), 1000, 'flush')
    expect(first).toEqual({ published: 0, failed: 0, detached: 1 })
    await within(outbox.flush(dispatch), 1000, 'flush')
    expect(calls).toBe(1) // still in flight → not selected again (no duplicate)

    release()
    await tick(5)
    const [entry] = await store.all()
    expect(entry!.publishedAt).toBeDefined()
    expect(entry!.attempts).toBe(0)
  })

  it('a late failure of a detached dispatch is marked failed and backed off', async () => {
    const store = new MemoryOutboxStore()
    const outbox = new Outbox(store, { dispatchTimeoutMs: 5 })
    await outbox.enqueue('slow', {}, 'tenant-a')
    let fail!: (error: Error) => void
    const gate = new Promise<void>((_, reject) => (fail = reject))
    await within(outbox.flush(() => gate), 1000, 'flush')
    fail(new Error('gateway timeout'))
    await tick(5)
    const [entry] = await store.all()
    expect(entry!.attempts).toBe(1)
    expect(entry!.lastError).toBe('gateway timeout')
    expect(entry!.publishedAt).toBeUndefined()
  })

  it('interleaves tenants in a batch while keeping each tenant FIFO', async () => {
    let clock = 0
    const outbox = new Outbox(new MemoryOutboxStore(), { now: () => clock, concurrency: 1 })
    for (const [tenant, n] of [['a', 1], ['a', 2], ['a', 3], ['b', 1], ['b', 2], [undefined, 1]] as const) {
      clock += 1
      await outbox.enqueue('e', { n, tenant }, tenant)
    }
    const order: string[] = []
    await outbox.flush(async (entry) => {
      const p = entry.payload as { n: number; tenant?: string }
      order.push(`${p.tenant ?? '-'}${p.n}`)
    })
    expect(order).toEqual(['a1', 'b1', '-1', 'a2', 'b2', 'a3'])
  })

  it('still selects other tenants when the store ignores the tenant filter', async () => {
    // A third-party store that predates the filter argument.
    const inner = new MemoryOutboxStore()
    const legacy: OutboxStore = {
      enqueue: (e) => inner.enqueue(e),
      pending: (limit, maxAttempts) => inner.pending(limit, maxAttempts),
      markPublished: (id, at) => inner.markPublished(id, at),
      markFailed: (id, error) => inner.markFailed(id, error),
      all: () => inner.all(),
    }
    let clock = 0
    const outbox = new Outbox(legacy, { now: () => clock, dispatchTimeoutMs: 5 })
    for (let i = 0; i < 10; i++) {
      clock += 1
      await outbox.enqueue('a', {}, 'tenant-a')
    }
    clock += 1
    await outbox.enqueue('b', {}, 'tenant-b')
    const delivered: string[] = []
    await within(
      outbox.flush(async (entry) => {
        if (entry.tenantId === 'tenant-a') return never
        delivered.push(entry.tenantId!)
      }, 50),
      1000,
      'flush',
    )
    expect(delivered).toEqual(['tenant-b'])
  })
})
