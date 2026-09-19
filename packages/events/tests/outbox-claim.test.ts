import { describe, expect, it } from 'vitest'
import {
  MemoryOutboxStore,
  Outbox,
  type OutboxEntry,
  type OutboxStore,
  type OutboxStoreEnqueueOptions,
} from '../src/index.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('Outbox.enqueue — transaction handle', () => {
  it('forwards { tx } to the store (and accepts the options-object form)', async () => {
    const calls: [string, string | undefined, OutboxStoreEnqueueOptions | undefined][] = []
    const inner = new MemoryOutboxStore()
    const store: OutboxStore = {
      enqueue: (entry, options) => {
        calls.push([entry.event, entry.tenantId, options])
        return inner.enqueue(entry, options)
      },
      pending: (...a) => inner.pending(...a),
      markPublished: (...a) => inner.markPublished(...a),
      markFailed: (...a) => inner.markFailed(...a),
      all: () => inner.all(),
    }
    const outbox = new Outbox(store)
    const tx = { marker: 'tx-client' }
    await outbox.enqueue('a', 1, 'acme', { tx })
    await outbox.enqueue('b', 2, { tenantId: 'globex', tx })
    await outbox.enqueue('c', 3)
    expect(calls).toEqual([
      ['a', 'acme', { tx }],
      ['b', 'globex', { tx }],
      ['c', undefined, undefined],
    ])
  })
})

describe('Outbox — claiming across relays (replicas)', () => {
  it('two relays on one store never dispatch the same entry twice', async () => {
    const store = new MemoryOutboxStore()
    const relayA = new Outbox(store, { dispatchTimeoutMs: false })
    const relayB = new Outbox(store, { dispatchTimeoutMs: false })
    for (let i = 0; i < 10; i++) await relayA.enqueue('e', { i })

    const gate = deferred()
    const deliveries: number[] = []
    const dispatch = async (entry: OutboxEntry) => {
      deliveries.push((entry.payload as { i: number }).i)
      await gate.promise
    }
    const flushA = relayA.flush(dispatch)
    const flushB = relayB.flush(dispatch)
    gate.resolve()
    const [a, b] = await Promise.all([flushA, flushB])

    expect(a.published + b.published).toBe(10)
    expect(deliveries.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect((await store.all()).every((entry) => entry.publishedAt !== undefined)).toBe(true)
  })

  it('a claim held by a crashed relay expires after claimLeaseMs and another relay takes over', async () => {
    let clock = 0
    const store = new MemoryOutboxStore()
    const crashed = new Outbox(store, { now: () => clock, dispatchTimeoutMs: 5, claimLeaseMs: 60_000 })
    const healthy = new Outbox(store, { now: () => clock, claimLeaseMs: 60_000 })
    await crashed.enqueue('e', { id: 1 })

    // The first relay claims the entry and its dispatch never settles (process died).
    const hung = await crashed.flush(() => new Promise<void>(() => {}))
    expect(hung).toEqual({ published: 0, failed: 0, detached: 1 })

    const delivered: unknown[] = []
    clock = 30_000 // lease still held → the other relay must not touch it
    expect((await healthy.flush((entry) => void delivered.push(entry.payload))).published).toBe(0)
    clock = 60_001 // lease expired → recovered
    expect((await healthy.flush((entry) => void delivered.push(entry.payload))).published).toBe(1)
    expect(delivered).toEqual([{ id: 1 }])
  })

  it('a failed entry stays claimed until its backoff elapses — on EVERY relay', async () => {
    let clock = 0
    const store = new MemoryOutboxStore()
    const backoff = { type: 'fixed' as const, delayMs: 10_000 }
    const relayA = new Outbox(store, { now: () => clock, backoff })
    const relayB = new Outbox(store, { now: () => clock, backoff })
    await relayA.enqueue('e', {})

    expect((await relayA.flush(() => Promise.reject(new Error('down')))).failed).toBe(1)
    // Relay B has no process-local memory of that failure, but the store does.
    let calls = 0
    clock = 5_000
    expect((await relayB.flush(() => void calls++)).published).toBe(0)
    expect(calls).toBe(0)
    clock = 10_000
    expect((await relayB.flush(() => void calls++)).published).toBe(1)
    expect(calls).toBe(1)
  })

  it('a store without claim() keeps working (backwards compatible)', async () => {
    const inner = new MemoryOutboxStore()
    const store: OutboxStore = {
      enqueue: (entry) => inner.enqueue(entry),
      pending: (...a) => inner.pending(...a),
      markPublished: (...a) => inner.markPublished(...a),
      markFailed: (id, error) => inner.markFailed(id, error),
      all: () => inner.all(),
    }
    const outbox = new Outbox(store)
    await outbox.enqueue('e', {})
    expect(await outbox.flush(() => {})).toEqual({ published: 1, failed: 0 })
  })
})
