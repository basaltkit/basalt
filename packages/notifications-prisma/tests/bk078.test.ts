import { NotificationPreferences } from '@basaltkit/notifications'
import { describe, expect, it } from 'vitest'
import {
  ColumnLengthError,
  PrismaInAppStore,
  PrismaPreferenceStore,
  prismaPreferenceStore,
  type PrismaNotificationPreferencesClient,
  type PrismaNotificationsClient,
} from '../src/index.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>

/** Evaluates the small subset of Prisma `where` the stores use. */
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key] ?? null
    if (cond === null) return value === null
    if (cond instanceof Date) return value?.getTime() === cond.getTime()
    if (typeof cond === 'object') {
      if ('lt' in cond && !(value !== null && value.getTime() < cond.lt.getTime())) return false
      return true
    }
    return value === cond
  })

function fakeInApp(): { client: PrismaNotificationsClient; rows: Row[]; calls: Row[] } {
  const rows: Row[] = []
  const calls: Row[] = []
  return {
    rows,
    calls,
    client: {
      inAppNotification: {
        async create({ data }) {
          calls.push({ op: 'create', data })
          rows.push({ groupKey: null, count: null, ...data })
          return data
        },
        async findMany({ where, take }) {
          const out = rows.filter((r) => matches(r, where)).sort((a, b) => b.at.getTime() - a.at.getTime())
          return (take !== undefined ? out.slice(0, take) : out) as any
        },
        async updateMany({ where, data }) {
          let count = 0
          for (const r of rows) {
            if (!matches(r, where)) continue
            count++
            for (const [k, v] of Object.entries(data as Row)) {
              r[k] = v !== null && typeof v === 'object' && 'increment' in v ? r[k] + v.increment : v
            }
          }
          return { count }
        },
        async count({ where }) {
          return rows.filter((r) => matches(r, where)).length
        },
        async deleteMany({ where }) {
          const keep = rows.filter((r) => !matches(r, where))
          const count = rows.length - keep.length
          rows.splice(0, rows.length, ...keep)
          return { count }
        },
      },
    },
  }
}

describe('BK-078 · PrismaInAppStore capabilities', () => {
  it('markAllRead is a single uncapped updateMany for one recipient', async () => {
    const { client } = fakeInApp()
    const store = new PrismaInAppStore(client)
    for (let i = 0; i < 120; i++) await store.append({ id: `n${i}`, recipientId: 'u1', notification: 't', title: 'x', at: i })
    await store.append({ id: 'o', recipientId: 'u2', notification: 't', title: 'x', at: 1 })
    expect(await store.markAllRead('u1')).toBe(120)
    expect(await store.unreadCount('u1')).toBe(0)
    expect(await store.unreadCount('u2')).toBe(1)
  })

  it('does not write grouping columns for a notification that does not group', async () => {
    const { client, calls } = fakeInApp()
    await new PrismaInAppStore(client).append({ id: 'n1', recipientId: 'u1', notification: 't', title: 'x', at: 1 })
    expect(Object.keys(calls[0]!['data'])).not.toContain('groupKey')
    expect(Object.keys(calls[0]!['data'])).not.toContain('count')
  })

  it('upsertGroup bumps the unread row and starts a new one once read', async () => {
    const { client } = fakeInApp()
    const store = new PrismaInAppStore(client)
    await store.upsertGroup({ id: 'a', recipientId: 'u1', notification: 'c', title: 'Ana', at: 1, groupKey: 'g' })
    await store.upsertGroup({ id: 'b', recipientId: 'u1', notification: 'c', title: 'Rui', at: 2, groupKey: 'g' })
    await store.upsertGroup({ id: 'c', recipientId: 'u2', notification: 'c', title: 'Ana', at: 3, groupKey: 'g' })
    let rows = await store.list('u1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'a', title: 'Rui', count: 2, groupKey: 'g' })

    await store.markRead('u1', 'a')
    await store.upsertGroup({ id: 'd', recipientId: 'u1', notification: 'c', title: 'Eva', at: 4, groupKey: 'g' })
    rows = await store.list('u1')
    expect(rows.map((r) => [r.id, r.count])).toEqual([
      ['d', 1],
      ['a', 2],
    ])
  })

  it('upsertGroup refuses an over-long group key under mysql limits', async () => {
    const { client } = fakeInApp()
    const store = new PrismaInAppStore(client, { columnLimits: 'mysql' })
    await expect(
      store.upsertGroup({ id: 'a', recipientId: 'u1', notification: 'c', title: 'x', at: 1, groupKey: 'g'.repeat(300) }),
    ).rejects.toBeInstanceOf(ColumnLengthError)
  })

  it('prune deletes by read/unread age', async () => {
    const { client } = fakeInApp()
    const store = new PrismaInAppStore(client)
    await store.append({ id: 'old-read', recipientId: 'u1', notification: 't', title: 'x', at: 1, readAt: 5 })
    await store.append({ id: 'new-read', recipientId: 'u2', notification: 't', title: 'x', at: 1, readAt: 50 })
    await store.append({ id: 'old-unread', recipientId: 'u1', notification: 't', title: 'x', at: 2 })
    await store.append({ id: 'new-unread', recipientId: 'u1', notification: 't', title: 'x', at: 40 })
    expect(await store.prune({})).toBe(0)
    expect(await store.prune({ readBefore: 10, unreadBefore: 10 })).toBe(2)
    expect((await store.list('u1')).map((n) => n.id)).toEqual(['new-unread'])
  })

  it('reads rows from a client generated before the grouping columns existed', async () => {
    const legacy: PrismaNotificationsClient = {
      inAppNotification: {
        findMany: async () => [
          { id: 'n1', recipientId: 'u1', notification: 't', title: 'x', body: null, data: null, readAt: null, at: new Date(1) },
        ],
        create: async (a: any) => a.data,
        updateMany: async () => ({ count: 0 }),
        count: async () => 0,
      },
    }
    expect(await new PrismaInAppStore(legacy).list('u1')).toEqual([
      { id: 'n1', recipientId: 'u1', notification: 't', title: 'x', at: 1 },
    ])
  })
})

function fakePrefs(): PrismaNotificationPreferencesClient {
  const rows = new Map<string, Row>()
  const k = (r: Row) => JSON.stringify([r.userId, r.notification, r.channel])
  return {
    notificationPreference: {
      async upsert({ where, create, update }) {
        const key = k(where.userId_notification_channel)
        const row = rows.get(key) ? { ...rows.get(key)!, ...update } : create
        rows.set(key, row)
        return row
      },
      async findMany({ where }) {
        return [...rows.values()].filter((r) => r.userId === where.userId) as any
      },
      async deleteMany({ where }) {
        return { count: rows.delete(k(where)) ? 1 : 0 }
      },
    },
  }
}

describe('BK-078 · PrismaPreferenceStore', () => {
  it('upserts, lists and removes', async () => {
    const store = prismaPreferenceStore(fakePrefs())
    expect(store).toBeInstanceOf(PrismaPreferenceStore)
    const prefs = new NotificationPreferences(store)
    await prefs.optOut('u1', { channel: 'sms' })
    await prefs.optIn('u1', { channel: 'sms' })
    expect(await store.list('u1')).toEqual([{ userId: 'u1', notification: '*', channel: 'sms', enabled: true }])
    await store.remove('u1', '*', 'sms')
    expect(await store.list('u1')).toEqual([])
  })

  it('fails fast on a client without the model', () => {
    expect(() => prismaPreferenceStore({} as never)).toThrow(/notificationPreference/)
  })
})
