import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Outbox, type OutboxEntry } from '@basaltkit/events'
import { openOutboxDatabase, SqliteOutboxStore, sqliteOutboxStore } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'basalt-outbox-tx-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('SqliteOutboxStore — enqueue in the caller\'s transaction (real SQLite)', () => {
  it('a rolled-back transaction leaves neither the state change nor the entry', async () => {
    const { db, store } = sqliteOutboxStore()
    db.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL)')
    db.exec(`INSERT INTO orders VALUES ('o1', 'pending')`)
    const outbox = new Outbox(store)

    db.exec('BEGIN')
    db.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?`).run('o1')
    await outbox.enqueue('order.paid', { id: 'o1' }, { tx: db })
    db.exec('ROLLBACK')

    expect(await store.all()).toEqual([])
    expect((db.prepare('SELECT status FROM orders').get() as { status: string }).status).toBe('pending')
  })

  it('a committed transaction keeps both', async () => {
    const { db, store } = sqliteOutboxStore()
    const outbox = new Outbox(store)
    db.exec('BEGIN')
    await outbox.enqueue('order.paid', { id: 'o1' }, { tenantId: 'acme', tx: db })
    db.exec('COMMIT')
    expect(await store.all()).toMatchObject([{ event: 'order.paid', tenantId: 'acme' }])
  })

  it('writes through a different handle when tx is another connection to the same file', async () => {
    const file = join(dir, 'app.db')
    const { store } = sqliteOutboxStore(file)
    const app = openOutboxDatabase(file) // the app's own connection
    app.exec('BEGIN')
    await store.enqueue({ event: 'e', payload: 1, createdAt: 1 }, { tx: app })
    app.exec('ROLLBACK')
    expect(await store.all()).toEqual([])
    app.close()
  })
})

describe('SqliteOutboxStore — claim (several relay processes on one file)', () => {
  it('two relays on separate connections never dispatch the same entry twice', async () => {
    const file = join(dir, 'relays.db')
    const relays = [0, 1].map(() => new Outbox(sqliteOutboxStore(file).store))
    for (let i = 0; i < 20; i++) await relays[0]!.enqueue('e', { i })

    const deliveries: number[] = []
    const dispatch = async (entry: OutboxEntry) => {
      deliveries.push((entry.payload as { i: number }).i)
      await new Promise((r) => setTimeout(r, 1))
    }
    const results = await Promise.all(relays.map((relay) => relay.flush(dispatch)))
    expect(results[0]!.published + results[1]!.published).toBe(20)
    expect(deliveries.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  it('claim() wins only unclaimed or expired rows; pending() hides active claims', async () => {
    const store = new SqliteOutboxStore(openOutboxDatabase())
    await store.enqueue({ id: 'a', event: 'e', payload: 1, createdAt: 1 })
    await store.enqueue({ id: 'b', event: 'e', payload: 1, tenantId: 't', createdAt: 2 })
    expect(await store.claim(['a'], { token: 't1', until: 100, now: 0 })).toEqual(['a'])
    expect(await store.claim(['a', 'b'], { token: 't2', until: 100, now: 50 })).toEqual(['b'])
    expect(await store.pending(10, 5, { now: 50 })).toEqual([])
    expect((await store.pending(10, 5, { now: 100, excludeGlobal: true })).map((e) => e.id)).toEqual(['b'])
    await store.markPublished('b', 5)
    await store.markFailed('a', 'down', { retryAt: 300 })
    expect((await store.pending(10, 5, { now: 299 })).map((e) => e.id)).toEqual([])
    expect((await store.pending(10, 5, { now: 300 })).map((e) => e.id)).toEqual(['a'])
  })

  it('migrates an existing outbox table without the claim columns', async () => {
    const file = join(dir, 'legacy.db')
    const { DatabaseSync } = await import('node:sqlite')
    const legacy = new DatabaseSync(file)
    legacy.exec(`CREATE TABLE outbox (id TEXT PRIMARY KEY, event TEXT NOT NULL, payload TEXT, tenant_id TEXT,
      created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, published_at INTEGER, last_error TEXT)`)
    legacy.exec(`INSERT INTO outbox (id, event, payload, created_at) VALUES ('old', 'e', '1', 1)`)
    legacy.close()
    const { store } = sqliteOutboxStore(file)
    expect(await store.claim(['old'], { token: 't', until: 10, now: 0 })).toEqual(['old'])
  })
})
