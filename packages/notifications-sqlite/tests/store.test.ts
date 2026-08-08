import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InAppNotification } from '@machize/notifications'
import { afterAll, describe, expect, it } from 'vitest'
import { openNotificationsDatabase, SqliteInAppStore, sqliteInAppStore } from '../src/index.js'

const note = (over: Partial<InAppNotification> & Pick<InAppNotification, 'id' | 'at'>): InAppNotification => ({
  recipientId: 'u1', notification: 'welcome', title: 'Hi', ...over,
})

describe('SqliteInAppStore', () => {
  it('appends, lists newest-first, filters unread and limits', async () => {
    const store = new SqliteInAppStore(openNotificationsDatabase())
    await store.append(note({ id: 'n1', at: 10, body: 'one', data: { k: 1 } }))
    await store.append(note({ id: 'n2', at: 20 }))
    await store.append(note({ id: 'n3', at: 30, recipientId: 'u2' }))

    expect((await store.list('u1')).map((n) => n.id)).toEqual(['n2', 'n1'])
    expect((await store.list('u1', { limit: 1 })).map((n) => n.id)).toEqual(['n2'])
    const n1 = (await store.list('u1')).find((n) => n.id === 'n1')
    expect(n1?.body).toBe('one')
    expect(n1?.data).toEqual({ k: 1 })
    expect((await store.list('u1')).find((n) => n.id === 'n2')?.body).toBeUndefined()

    expect(await store.unreadCount('u1')).toBe(2)
    expect((await store.list('u1', { unreadOnly: true })).length).toBe(2)
  })

  it('marks read once (idempotent) and updates the unread count', async () => {
    const store = new SqliteInAppStore(openNotificationsDatabase())
    await store.append(note({ id: 'n1', at: 10 }))

    expect(await store.markRead('u1', 'n1')).toBe(true)
    expect(await store.markRead('u1', 'n1')).toBe(false) // already read
    expect(await store.markRead('u1', 'ghost')).toBe(false) // not found
    expect(await store.markRead('u2', 'n1')).toBe(false) // wrong recipient
    expect(await store.unreadCount('u1')).toBe(0)
    expect((await store.list('u1', { unreadOnly: true })).length).toBe(0)
    expect((await store.list('u1'))[0]?.readAt).toBeGreaterThan(0)
  })
})

describe('sqliteInAppStore + durability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'machize-notif-'))
  const file = join(dir, 'notifications.db')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('bundles the store named for notificationsPlugin', () => {
    expect(sqliteInAppStore().store).toBeInstanceOf(SqliteInAppStore)
  })

  it('accepts an existing DatabaseSync and migrates it', async () => {
    const db = openNotificationsDatabase()
    const n = sqliteInAppStore(db)
    expect(n.db).toBe(db)
    await n.store.append(note({ id: 'n1', at: 1 }))
    expect(await new SqliteInAppStore(db).unreadCount('u1')).toBe(1)
  })

  it('survives a process restart', async () => {
    const first = sqliteInAppStore(file)
    await first.store.append(note({ id: 'n1', at: 1, data: { k: 1 } }))
    first.db.close()
    const second = sqliteInAppStore(file)
    const rows = await second.store.list('u1')
    expect(rows[0]?.data).toEqual({ k: 1 })
    expect(await second.store.unreadCount('u1')).toBe(1)
    second.db.close()
  })
})
