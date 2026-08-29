import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  openSubscriptionsDatabase,
  SqliteSubscriptionStore,
  SqliteUsageStore,
  SqliteWebhookStore,
  sqliteSubscriptionsStores,
  migrate,
} from '../src/index.js'

describe('SqliteSubscriptionStore', () => {
  it('saves, upserts, gets and lists', async () => {
    const store = new SqliteSubscriptionStore(openSubscriptionsDatabase())
    await store.save({ billableId: 'acme', plan: 'pro', period: 'monthly', status: 'active' })
    await store.save({
      billableId: 'globex', plan: 'team', period: 'yearly', status: 'trialing',
      trialEndsAt: 999, cancelAtPeriodEnd: true, canceledAt: 1000, gatewayRef: 'sub_x',
    })

    const acme = await store.get('acme')
    expect(acme?.plan).toBe('pro')
    expect(acme?.trialEndsAt).toBeUndefined()
    expect(acme?.cancelAtPeriodEnd).toBeUndefined()

    const globex = await store.get('globex')
    expect(globex).toEqual({
      billableId: 'globex', plan: 'team', period: 'yearly', status: 'trialing',
      trialEndsAt: 999, cancelAtPeriodEnd: true, canceledAt: 1000, gatewayRef: 'sub_x',
    })

    expect(await store.get('missing')).toBeNull()

    await store.save({ billableId: 'acme', plan: 'enterprise', period: 'monthly', status: 'active' }) // upsert
    expect((await store.get('acme'))?.plan).toBe('enterprise')

    // pending-plan intent (escalation guard) round-trips and clears
    await store.save({
      billableId: 'acme', plan: 'enterprise', period: 'monthly', status: 'active',
      gatewayRef: 'sub_1', pendingPlan: 'mega', pendingPeriod: 'yearly',
    })
    expect(await store.get('acme')).toMatchObject({ pendingPlan: 'mega', pendingPeriod: 'yearly', gatewayRef: 'sub_1' })
    await store.save({ billableId: 'acme', plan: 'mega', period: 'yearly', status: 'active', gatewayRef: 'sub_2' })
    const promoted = await store.get('acme')
    expect(promoted?.pendingPlan).toBeUndefined()
    expect(promoted?.pendingPeriod).toBeUndefined()

    expect((await store.all()).map((s) => s.billableId)).toEqual(['acme', 'globex'])

    // cancelAtPeriodEnd: false round-trips as false (not undefined)
    await store.save({ billableId: 'z', plan: 'pro', period: 'monthly', status: 'active', cancelAtPeriodEnd: false })
    expect((await store.get('z'))?.cancelAtPeriodEnd).toBe(false)
  })
})

describe('SqliteWebhookStore', () => {
  it('claims an id once and can release it', async () => {
    const store = new SqliteWebhookStore(openSubscriptionsDatabase())
    expect(await store.markProcessed('evt_1')).toBe(true) // newly claimed
    expect(await store.markProcessed('evt_1')).toBe(false) // already seen
    await store.release('evt_1')
    expect(await store.markProcessed('evt_1')).toBe(true) // free again → reprocess
  })
})

describe('SqliteUsageStore', () => {
  it('gets, increments and reports totals', async () => {
    const store = new SqliteUsageStore(openSubscriptionsDatabase())
    expect(await store.get('acme', 'api', 'lifetime')).toBe(0)
    expect(await store.increment('acme', 'api', 'lifetime', 3)).toBe(3)
    expect(await store.increment('acme', 'api', 'lifetime', 2)).toBe(5)
    expect(await store.get('acme', 'api', 'lifetime')).toBe(5)
    // scoped by billable/feature/period
    expect(await store.get('acme', 'api', '2026-08')).toBe(0)
  })

  it('consume applies only within the limit', async () => {
    const store = new SqliteUsageStore(openSubscriptionsDatabase())
    expect(await store.consume('acme', 'seats', 'lifetime', 3, 5)).toEqual({ applied: true, used: 3 })
    expect(await store.consume('acme', 'seats', 'lifetime', 2, 5)).toEqual({ applied: true, used: 5 })
    // would exceed → rejected, usage unchanged
    expect(await store.consume('acme', 'seats', 'lifetime', 1, 5)).toEqual({ applied: false, used: 5 })
    expect(await store.get('acme', 'seats', 'lifetime')).toBe(5)
  })

  it('never overshoots the limit under concurrent consume', async () => {
    const store = new SqliteUsageStore(openSubscriptionsDatabase())
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.consume('acme', 'seats', 'm', 1, 5)),
    )
    expect(results.filter((r) => r.applied).length).toBe(5)
    expect(await store.get('acme', 'seats', 'm')).toBe(5)
  })

  it('rolls back and rethrows on a mid-transaction failure', async () => {
    const calls: string[] = []
    // A db that begins fine but fails on the first statement inside the txn.
    const fakeDb = {
      exec: (sql: string) => { calls.push(sql.trim()) },
      prepare: () => { throw new Error('boom') },
    } as unknown as DatabaseSync
    const store = new SqliteUsageStore(fakeDb)
    await expect(store.consume('acme', 'seats', 'm', 1, 5)).rejects.toThrow('boom')
    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']) // rolled back, no COMMIT
  })

  it('reports used=0 if the counter row is absent on read-back (defensive)', async () => {
    // not-applied path where the read-back finds no row (a race dropped it)
    const fakeDb = {
      exec: () => {},
      prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined }),
    } as unknown as DatabaseSync
    const store = new SqliteUsageStore(fakeDb)
    expect(await store.consume('acme', 'seats', 'm', 1, 5)).toEqual({ applied: false, used: 0 })
  })
})

describe('sqliteSubscriptionsStores + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-subs-'))
  const file = join(dir, 'billing.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles all three stores named for subscriptionsPlugin', () => {
    const s = sqliteSubscriptionsStores()
    expect(s.store).toBeInstanceOf(SqliteSubscriptionStore)
    expect(s.usage).toBeInstanceOf(SqliteUsageStore)
    expect(s.webhooks).toBeInstanceOf(SqliteWebhookStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openSubscriptionsDatabase()
    const s = sqliteSubscriptionsStores(db)
    expect(s.db).toBe(db)
    await s.store.save({ billableId: 'acme', plan: 'pro', period: 'monthly', status: 'active' })
    expect(await new SqliteSubscriptionStore(db).get('acme')).not.toBeNull()
  })

  it('survives a process restart (data persists to disk)', async () => {
    const first = sqliteSubscriptionsStores(file)
    await first.store.save({ billableId: 'acme', plan: 'pro', period: 'monthly', status: 'active' })
    await first.usage.increment('acme', 'api', 'lifetime', 7)
    await first.webhooks.markProcessed('evt_persist')
    first.db.close()

    const second = sqliteSubscriptionsStores(file)
    expect((await second.store.get('acme'))?.plan).toBe('pro')
    expect(await second.usage.get('acme', 'api', 'lifetime')).toBe(7)
    expect(await second.webhooks.markProcessed('evt_persist')).toBe(false) // still claimed
    second.db.close()
  })
})

describe('schema evolution', () => {
  it('adds pending_plan/pending_period to a database created before the escalation guard', async () => {
    // A pre-1.x subscriptions table: no pending-plan columns at all.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE subscriptions (
        billable_id          TEXT PRIMARY KEY,
        plan                 TEXT NOT NULL,
        period               TEXT NOT NULL,
        status               TEXT NOT NULL,
        trial_ends_at        INTEGER,
        cancel_at_period_end INTEGER,
        canceled_at          INTEGER,
        gateway_ref          TEXT
      );
    `)

    migrate(db)

    const columns = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('subscriptions')
      .map((r) => (r as { name: string }).name)
    expect(columns).toContain('pending_plan')
    expect(columns).toContain('pending_period')

    // ...and save(), which always writes both, now succeeds on the old DB.
    const store = new SqliteSubscriptionStore(db)
    await store.save({
      billableId: 'acme', plan: 'pro', period: 'monthly', status: 'incomplete',
      pendingPlan: 'enterprise', pendingPeriod: 'yearly',
    })
    expect(await store.get('acme')).toMatchObject({ pendingPlan: 'enterprise', pendingPeriod: 'yearly' })
    db.close()
  })
})
