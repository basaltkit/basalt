import { describe, expect, it, vi } from 'vitest'
import { verifySignature, WebhookDeliverer, WebhookManager } from '@basaltkit/webhooks'
import { migrate, openWebhooksDatabase, SqliteWebhookStore } from '../src/index.js'

const sqliteSpecifier = 'node:sqlite'
const { DatabaseSync } = (await import(sqliteSpecifier)) as typeof import('node:sqlite')

describe('SqliteWebhookStore — secret rotation columns', () => {
  it('round-trips previousSecret/previousSecretExpiresAt and clears them on a replace without them', async () => {
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    const expires = new Date('2026-10-01T00:00:00.000Z')
    await store.add({ id: 'e', url: 'u', events: ['*'], tenantId: 'acme', secret: 'n'.repeat(16), previousSecret: 'o'.repeat(16), previousSecretExpiresAt: expires })
    const [row] = await store.list('acme')
    expect(row).toMatchObject({ previousSecret: 'o'.repeat(16), previousSecretExpiresAt: expires })
    expect(row!.previousSecretExpiresAt).toBeInstanceOf(Date)

    await store.add({ id: 'e', url: 'u', events: ['*'], tenantId: 'acme', secret: 'r'.repeat(16) })
    const [after] = await store.list('acme')
    expect(after).not.toHaveProperty('previousSecret')
    expect(after).not.toHaveProperty('previousSecretExpiresAt')
  })

  it('migrate() adds the columns to a table created by an earlier version (rows kept)', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE webhook_endpoints (id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL, tenant_id TEXT, secret TEXT, active INTEGER)`)
    db.prepare(`INSERT INTO webhook_endpoints (id, url, events, tenant_id, secret, active) VALUES ('old', 'u', '["*"]', NULL, NULL, NULL)`).run()
    migrate(db)
    migrate(db) // idempotent
    const store = new SqliteWebhookStore(db)
    expect(await store.list()).toEqual([{ id: 'old', url: 'u', events: ['*'] }])
    await store.add({ id: 'old', url: 'u', events: ['*'], secret: 'n'.repeat(16), previousSecret: 'o'.repeat(16), previousSecretExpiresAt: new Date(1) })
    expect((await store.list())[0]).toMatchObject({ previousSecret: 'o'.repeat(16) })
  })

  it('WebhookManager.rotateSecret() persists the grace window: both secrets sign', async () => {
    const fx = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }))
    const store = new SqliteWebhookStore(openWebhooksDatabase())
    const mgr = new WebhookManager(store, new WebhookDeliverer({ fetchImpl: fx as never, ssrf: false }))
    const e = await mgr.register({ url: 'https://hook.example/', events: ['*'], tenantId: 'acme' })
    const rotated = await mgr.rotateSecret(e.id, { tenantId: 'acme' })
    await mgr.dispatch('a.b', {}, 'acme')
    const init = fx.mock.calls[0]![1]
    const header = (init.headers as Record<string, string>)['x-basalt-signature']!
    expect(verifySignature(header, init.body as string, e.secret!)).toBe(true)
    expect(verifySignature(header, init.body as string, rotated.secret!)).toBe(true)
  })
})
