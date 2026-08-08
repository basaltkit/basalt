import type { InAppNotification } from '@machize/notifications'
import { beforeEach, describe, expect, it } from 'vitest'
import { PrismaInAppStore, type PrismaNotificationsClient, prismaInAppStore } from '../src/index.js'

interface NRow {
  id: string; recipientId: string; notification: string; title: string
  body: string | null; data: string | null; readAt: Date | null; at: Date
}

function makeFakeClient(): PrismaNotificationsClient {
  const rows: NRow[] = []
  return {
    inAppNotification: {
      async create({ data }) {
        const row = { ...data } as NRow
        rows.push(row)
        return row
      },
      async findMany({ where, take }) {
        let out = rows.filter(
          (r) => r.recipientId === where.recipientId && (where.readAt !== null || r.readAt === null || true) && (where.readAt === null ? r.readAt === null : true),
        )
        out = out.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : -1))
        return take !== undefined ? out.slice(0, take) : out
      },
      async updateMany({ where, data }) {
        const row = rows.find((r) => r.id === where.id && r.recipientId === where.recipientId && r.readAt === null)
        if (!row) return { count: 0 }
        row.readAt = data.readAt
        return { count: 1 }
      },
      async count({ where }) {
        return rows.filter((r) => r.recipientId === where.recipientId && r.readAt === null).length
      },
    },
  }
}

const note = (over: Partial<InAppNotification> & Pick<InAppNotification, 'id' | 'at'>): InAppNotification => ({
  recipientId: 'u1', notification: 'welcome', title: 'Hi', ...over,
})

let client: PrismaNotificationsClient
beforeEach(() => {
  client = makeFakeClient()
})

describe('PrismaInAppStore', () => {
  it('appends, lists newest-first, filters unread and limits', async () => {
    const store = new PrismaInAppStore(client)
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

    // a notification appended already-read round-trips its readAt
    await store.append(note({ id: 'n4', at: 40, readAt: 999 }))
    expect((await store.list('u1')).find((n) => n.id === 'n4')?.readAt).toBe(999)
  })

  it('marks read once (idempotent) and updates the unread count', async () => {
    const store = new PrismaInAppStore(client)
    await store.append(note({ id: 'n1', at: 10 }))

    expect(await store.markRead('u1', 'n1')).toBe(true)
    expect(await store.markRead('u1', 'n1')).toBe(false)
    expect(await store.markRead('u1', 'ghost')).toBe(false)
    expect(await store.markRead('u2', 'n1')).toBe(false)
    expect(await store.unreadCount('u1')).toBe(0)
    expect((await store.list('u1'))[0]?.readAt).toBeGreaterThan(0)
  })
})

describe('prismaInAppStore', () => {
  it('bundles the store named for notificationsPlugin', () => {
    expect(prismaInAppStore(client).store).toBeInstanceOf(PrismaInAppStore)
  })
})
