import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openWebhooksDatabase, SqliteWebhookStore, sqliteWebhookStore } from '../src/index.js'

describe('SqliteWebhookStore', () => {
  it('adds (auto id) and round-trips every field', async () => {
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    const ep = await store.add({ url: 'https://a.test', events: ['invoice.*'], secret: 's', tenantId: 'acme' })
    expect(ep.id).toMatch(/[0-9a-f-]{36}/)

    const [stored] = await store.list()
    expect(stored).toEqual({ id: ep.id, url: 'https://a.test', events: ['invoice.*'], secret: 's', tenantId: 'acme' })
  })

  it('forEvent matches patterns (exact, prefix, wildcard) and skips inactive', async () => {
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    await store.add({ id: 'exact', url: 'u', events: ['invoice.paid'] })
    await store.add({ id: 'prefix', url: 'u', events: ['invoice.*'] })
    await store.add({ id: 'star', url: 'u', events: ['*'] })
    await store.add({ id: 'other', url: 'u', events: ['order.created'] })
    await store.add({ id: 'off', url: 'u', events: ['invoice.paid'], active: false })

    const ids = (await store.forEvent('invoice.paid')).map((e) => e.id).sort()
    expect(ids).toEqual(['exact', 'prefix', 'star']) // 'other' no match, 'off' inactive
  })

  it('forEvent scopes by tenant (tenant-agnostic endpoints always match)', async () => {
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    await store.add({ id: 'global', url: 'u', events: ['*'] })
    await store.add({ id: 'acme', url: 'u', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'globex', url: 'u', events: ['*'], tenantId: 'globex' })

    expect((await store.forEvent('any', 'acme')).map((e) => e.id).sort()).toEqual(['acme', 'global'])
  })

  it('list filters by exact tenant; remove deletes', async () => {
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    await store.add({ id: 'a', url: 'u', events: ['*'], tenantId: 'acme' })
    await store.add({ id: 'b', url: 'u', events: ['*'] })

    expect((await store.list('acme')).map((e) => e.id)).toEqual(['a'])
    await store.remove('a')
    expect((await store.list('acme')).length).toBe(0)
  })

  it('re-adding the same id replaces the endpoint', async () => {
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    await store.add({ id: 'x', url: 'old', events: ['*'] })
    await store.add({ id: 'x', url: 'new', events: ['invoice.*'] })
    const [ep] = await store.list()
    expect(ep?.url).toBe('new')
    expect(ep?.events).toEqual(['invoice.*'])
  })
})

describe('sqliteWebhookStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-webhooks-'))
  const file = join(dir, 'webhooks.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for webhooksPlugin', () => {
    expect(sqliteWebhookStore().store).toBeInstanceOf(SqliteWebhookStore)
  })

  it('subscriptions survive a restart', async () => {
    await sqliteWebhookStore(file).store.add({ id: 'keep', url: 'u', events: ['invoice.paid'] })
    const reopened = sqliteWebhookStore(file)
    expect((await reopened.store.forEvent('invoice.paid')).map((e) => e.id)).toEqual(['keep'])
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openWebhooksDatabase()
    const w = sqliteWebhookStore(db)
    expect(w.db).toBe(db)
    await w.store.add({ id: 'a', url: 'u', events: ['*'] })
    expect((await new SqliteWebhookStore(db).list()).length).toBe(1)
  })
})
