import { NotificationPreferences } from '@basaltkit/notifications'
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate, openNotificationsDatabase, SqliteInAppStore, sqliteInAppStore } from '../src/index.js'

describe('BK-078 · SqliteInAppStore capabilities', () => {
  it('markAllRead marks every unread row of one recipient, uncapped', async () => {
    const store = new SqliteInAppStore(openNotificationsDatabase())
    for (let i = 0; i < 120; i++) await store.append({ id: `n${i}`, recipientId: 'u1', notification: 't', title: 'x', at: i })
    await store.append({ id: 'other', recipientId: 'u2', notification: 't', title: 'x', at: 1 })
    expect(await store.markAllRead('u1')).toBe(120)
    expect(await store.unreadCount('u1')).toBe(0)
    expect(await store.unreadCount('u2')).toBe(1)
    expect(await store.markAllRead('u1')).toBe(0)
  })

  it('upsertGroup collapses unread repeats and restarts once read', async () => {
    const store = new SqliteInAppStore(openNotificationsDatabase())
    await store.upsertGroup({ id: 'a', recipientId: 'u1', notification: 'c', title: 'Ana', at: 1, groupKey: 'g' })
    await store.upsertGroup({ id: 'b', recipientId: 'u1', notification: 'c', title: 'Rui', at: 2, groupKey: 'g', data: { k: 1 } })
    await store.upsertGroup({ id: 'c', recipientId: 'u2', notification: 'c', title: 'Ana', at: 3, groupKey: 'g' })
    let rows = await store.list('u1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'a', title: 'Rui', count: 2, groupKey: 'g', at: 2, data: { k: 1 } })

    await store.markRead('u1', 'a')
    await store.upsertGroup({ id: 'd', recipientId: 'u1', notification: 'c', title: 'Eva', at: 4, groupKey: 'g' })
    rows = await store.list('u1')
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ['d', 1],
      ['a', 2],
    ])
  })

  it('prune deletes by read/unread age across recipients', async () => {
    const store = new SqliteInAppStore(openNotificationsDatabase())
    await store.append({ id: 'old-read', recipientId: 'u1', notification: 't', title: 'x', at: 1, readAt: 5 })
    await store.append({ id: 'new-read', recipientId: 'u2', notification: 't', title: 'x', at: 1, readAt: 50 })
    await store.append({ id: 'old-unread', recipientId: 'u1', notification: 't', title: 'x', at: 2 })
    await store.append({ id: 'new-unread', recipientId: 'u1', notification: 't', title: 'x', at: 40 })
    expect(await store.prune({})).toBe(0)
    expect(await store.prune({ readBefore: 10, unreadBefore: 10 })).toBe(2)
    expect((await store.list('u1')).map((n) => n.id)).toEqual(['new-unread'])
    expect((await store.list('u2')).map((n) => n.id)).toEqual(['new-read'])
  })

  it('migrates a database created before group_key/count existed', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE in_app_notifications (
      id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, notification TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT, data TEXT, read_at INTEGER, at INTEGER NOT NULL)`)
    db.prepare("INSERT INTO in_app_notifications (id, recipient_id, notification, title, at) VALUES ('old', 'u1', 't', 'x', 1)").run()
    migrate(db)
    const store = new SqliteInAppStore(db)
    expect(await store.list('u1')).toEqual([{ id: 'old', recipientId: 'u1', notification: 't', title: 'x', at: 1 }])
    await store.upsertGroup({ id: 'g1', recipientId: 'u1', notification: 't', title: 'y', at: 2, groupKey: 'g' })
    expect((await store.list('u1'))[0]).toMatchObject({ id: 'g1', count: 1 })
  })
})

describe('BK-078 · SqlitePreferenceStore', () => {
  it('persists, upserts and removes preferences', async () => {
    const { db, preferences } = sqliteInAppStore()
    const prefs = new NotificationPreferences(preferences)
    await prefs.optOut('u1', { channel: 'sms' })
    await prefs.optIn('u1', { channel: 'sms' })
    await prefs.optOut('u1', { notification: 'digest' })
    expect(await prefs.allowed('u1', 'invoice', 'sms')).toBe(true)
    expect(await prefs.allowed('u1', 'digest', 'mail')).toBe(false)
    expect((await preferences.list('u1')).length).toBe(2)
    await preferences.remove('u1', 'digest', '*')
    expect(await prefs.allowed('u1', 'digest', 'mail')).toBe(true)

    // Durable: a second store on the same database sees the same rows.
    const again = sqliteInAppStore(db).preferences
    expect(await again.list('u1')).toEqual([{ userId: 'u1', notification: '*', channel: 'sms', enabled: true }])
    expect(await again.list('u2')).toEqual([])
  })
})
