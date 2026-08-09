import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openOutboxDatabase, SqliteOutboxStore, sqliteOutboxStore } from '../src/index.js'

describe('SqliteOutboxStore', () => {
  it('enqueues (auto id, attempts 0) and round-trips the payload', async () => {
    const store = new SqliteOutboxStore(openOutboxDatabase())
    const entry = await store.enqueue({ event: 'order.created', payload: { id: 42 }, createdAt: 10 })
    expect(entry.id).toMatch(/[0-9a-f-]{36}/)
    expect(entry.attempts).toBe(0)
    expect(entry.publishedAt).toBeUndefined()

    const [stored] = await store.all()
    expect(stored?.event).toBe('order.created')
    expect(stored?.payload).toEqual({ id: 42 })
  })

  it('keeps tenantId only when given', async () => {
    const store = new SqliteOutboxStore(openOutboxDatabase())
    await store.enqueue({ id: 't', event: 'e', payload: 1, tenantId: 'acme', createdAt: 1 })
    await store.enqueue({ id: 'n', event: 'e', payload: 1, createdAt: 2 })
    const all = await store.all()
    expect(all.find((e) => e.id === 't')?.tenantId).toBe('acme')
    expect('tenantId' in (all.find((e) => e.id === 'n') ?? {})).toBe(false)
  })

  it('pending: unpublished, below the attempt ceiling, oldest first, limited', async () => {
    const store = new SqliteOutboxStore(openOutboxDatabase())
    await store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 30 })
    await store.enqueue({ id: 'b', event: 'e', payload: 1, createdAt: 10 })
    await store.enqueue({ id: 'c', event: 'e', payload: 1, createdAt: 20 })

    expect((await store.pending(10, 5)).map((e) => e.id)).toEqual(['b', 'c', 'a']) // by createdAt
    expect((await store.pending(2, 5)).map((e) => e.id)).toEqual(['b', 'c']) // limited

    await store.markPublished('b', 99)
    expect((await store.pending(10, 5)).map((e) => e.id)).toEqual(['c', 'a']) // published excluded
    expect((await store.all()).find((e) => e.id === 'b')?.publishedAt).toBe(99)
  })

  it('markFailed increments attempts and drops the entry past the ceiling', async () => {
    const store = new SqliteOutboxStore(openOutboxDatabase())
    await store.enqueue({ id: 'x', event: 'e', payload: 1, createdAt: 1 })

    await store.markFailed('x', 'boom')
    await store.markFailed('x', 'boom again')
    const x = (await store.all())[0]
    expect(x?.attempts).toBe(2)
    expect(x?.lastError).toBe('boom again')

    expect((await store.pending(10, 3)).map((e) => e.id)).toEqual(['x']) // 2 < 3, still pending
    expect((await store.pending(10, 2)).length).toBe(0) // 2 >= 2, excluded (dead)
  })

  it('re-enqueuing the same id replaces the entry (attempts reset)', async () => {
    const store = new SqliteOutboxStore(openOutboxDatabase())
    await store.enqueue({ id: 'x', event: 'e', payload: 1, createdAt: 1 })
    await store.markFailed('x', 'boom')
    await store.enqueue({ id: 'x', event: 'e', payload: 2, createdAt: 5 })

    const x = (await store.all())[0]
    expect(x?.attempts).toBe(0)
    expect(x?.lastError).toBeUndefined()
    expect(x?.payload).toBe(2)
  })
})

describe('sqliteOutboxStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-outbox-'))
  const file = join(dir, 'outbox.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for outboxPlugin', () => {
    expect(sqliteOutboxStore().store).toBeInstanceOf(SqliteOutboxStore)
  })

  it('un-relayed entries survive a restart', async () => {
    await sqliteOutboxStore(file).store.enqueue({ id: 'keep', event: 'e', payload: { a: 1 }, createdAt: 1 })
    // A fresh handle to the same file — as if the process crashed and restarted.
    const reopened = sqliteOutboxStore(file)
    expect((await reopened.store.pending(10, 5)).map((e) => e.id)).toEqual(['keep'])
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openOutboxDatabase()
    const o = sqliteOutboxStore(db)
    expect(o.db).toBe(db)
    await o.store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 1 })
    expect((await new SqliteOutboxStore(db).all()).length).toBe(1)
  })
})
