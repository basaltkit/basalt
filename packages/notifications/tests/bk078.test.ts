import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@basaltkit/core'
import {
  channel,
  defineNotification,
  InAppChannel,
  MemoryInAppStore,
  MemoryPreferenceStore,
  NotificationPreferences,
  Notifier,
  inAppRoutes,
  notificationsPlugin,
  type InAppNotification,
  type InAppStore,
} from '../src/index.js'

/**
 * BK-078 · read-all marked at most 100, inbox grouping and retention, and
 * per-definition channel defaults / mandatory channels.
 */

/** A store written against the original four-method contract: no optional capabilities. */
class LegacyStore implements InAppStore {
  readonly inner = new MemoryInAppStore()
  append(record: InAppNotification) {
    return this.inner.append(record)
  }
  list(recipientId: string, options?: { unreadOnly?: boolean; limit?: number }) {
    return this.inner.list(recipientId, options)
  }
  markRead(recipientId: string, id: string) {
    return this.inner.markRead(recipientId, id)
  }
  unreadCount(recipientId: string) {
    return this.inner.unreadCount(recipientId)
  }
}

const readAll = async (store: InAppStore, user = 'u1') => {
  const app = await createApp({ plugins: [notificationsPlugin({ inApp: store })] }).boot()
  const route = inAppRoutes().find((r) => r.url === '/me/notifications/read-all')!
  try {
    return await runWithContext({ user: { id: user }, container: app.container } as never, () =>
      (route.handler as (a: unknown) => Promise<unknown>)({ query: {}, params: {} }),
    )
  } finally {
    await app.shutdown()
  }
}

const seed = async (store: InAppStore, n: number, recipientId = 'u1') => {
  for (let i = 0; i < n; i++) {
    await store.append({ id: `${recipientId}-${i}`, recipientId, notification: 't', title: `#${i}`, at: i })
  }
}

describe('BK-078 · POST /me/notifications/read-all', () => {
  it('marks all 120 unread through markAllRead and reports the true count', async () => {
    const store = new MemoryInAppStore()
    await seed(store, 120)
    await seed(store, 3, 'u2')
    expect(await readAll(store)).toEqual({ marked: 120 })
    expect(await store.unreadCount('u1')).toBe(0)
    expect(await store.unreadCount('u2')).toBe(3)
  })

  it('pages through a store without markAllRead instead of stopping at 100', async () => {
    const store = new LegacyStore()
    await seed(store, 120)
    expect(await readAll(store)).toEqual({ marked: 120 })
    expect(await store.unreadCount('u1')).toBe(0)
  })

  it('stops on a store that lists rows it never marks (bounded loop)', async () => {
    const store = new LegacyStore()
    await seed(store, 250)
    let lists = 0
    const stuck: InAppStore = {
      append: (r) => store.append(r),
      list: (id, o) => {
        lists++
        return store.list(id, o)
      },
      markRead: async () => false,
      unreadCount: (id) => store.unreadCount(id),
    }
    expect(await readAll(stuck)).toEqual({ marked: 0 })
    expect(lists).toBe(1)
  })

  it('merges route meta, never letting auth be switched off', () => {
    const routes = inAppRoutes({ meta: { can: 'notifications:read', auth: false } })
    for (const r of routes) expect(r.meta).toEqual({ can: 'notifications:read', auth: true })
  })
})

describe('BK-078 · grouping', () => {
  const Commented = defineNotification<{ who: string }>({
    name: 'comment.added',
    channels: ['inApp'],
    via: { inApp: ({ who }) => ({ title: `${who} commented`, groupKey: 'doc:12:comments' }) },
  })

  it('collapses unread repeats onto one row and counts them', async () => {
    const store = new MemoryInAppStore()
    const notifier = new Notifier({ channels: [new InAppChannel(store)] })
    await notifier.notify({ id: 'u1' }, Commented, { who: 'Ana' })
    await notifier.notify({ id: 'u1' }, Commented, { who: 'Rui' })

    const rows = await store.list('u1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: 'Rui commented', groupKey: 'doc:12:comments', count: 2 })
    expect(await store.unreadCount('u1')).toBe(1)

    // Once read, the next one starts a new row.
    await store.markRead('u1', rows[0]!.id)
    await notifier.notify({ id: 'u1' }, Commented, { who: 'Eva' })
    const after = await store.list('u1')
    expect(after).toHaveLength(2)
    expect(after[0]).toMatchObject({ title: 'Eva commented', count: 1 })
  })

  it('keeps groups per recipient', async () => {
    const store = new MemoryInAppStore()
    const notifier = new Notifier({ channels: [new InAppChannel(store)] })
    await notifier.notify({ id: 'u1' }, Commented, { who: 'Ana' })
    await notifier.notify({ id: 'u2' }, Commented, { who: 'Ana' })
    expect(await store.unreadCount('u1')).toBe(1)
    expect(await store.unreadCount('u2')).toBe(1)
  })

  it('appends a row per notification on a store without upsertGroup', async () => {
    const store = new LegacyStore()
    const notifier = new Notifier({ channels: [new InAppChannel(store)] })
    await notifier.notify({ id: 'u1' }, Commented, { who: 'Ana' })
    await notifier.notify({ id: 'u1' }, Commented, { who: 'Rui' })
    const rows = await store.list('u1')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.groupKey).toBe('doc:12:comments')
  })
})

describe('BK-078 · prune', () => {
  it('deletes read rows before readBefore and unread rows before unreadBefore', async () => {
    const store = new MemoryInAppStore()
    await store.append({ id: 'old-read', recipientId: 'u1', notification: 't', title: 'a', at: 1, readAt: 5 })
    await store.append({ id: 'new-read', recipientId: 'u2', notification: 't', title: 'b', at: 1, readAt: 50 })
    await store.append({ id: 'old-unread', recipientId: 'u1', notification: 't', title: 'c', at: 2 })
    await store.append({ id: 'new-unread', recipientId: 'u1', notification: 't', title: 'd', at: 40 })

    expect(await store.prune({})).toBe(0)
    expect(await store.prune({ readBefore: 10 })).toBe(1)
    expect(await store.prune({ unreadBefore: 10 })).toBe(1)
    expect((await store.list('u1')).map((n) => n.id)).toEqual(['new-unread'])
    expect((await store.list('u2')).map((n) => n.id)).toEqual(['new-read'])
  })
})

describe('BK-078 · defaults and mandatory channels', () => {
  const sent: string[] = []
  const sms = channel('sms', async () => {
    sent.push('sms')
  })
  const mail = channel('mail', async () => {
    sent.push('mail')
  })
  const via = { sms: () => ({ body: 'x' }), mail: () => ({ subject: 'x' }) }

  const Digest = defineNotification({ name: 'digest', channels: ['sms', 'mail'], via, defaults: { sms: false } })
  const Reset = defineNotification({ name: 'password.reset', channels: ['sms', 'mail'], via, mandatory: ['mail'] })

  const setup = () => {
    sent.length = 0
    const preferences = new NotificationPreferences(new MemoryPreferenceStore())
    return { preferences, notifier: new Notifier({ channels: [sms, mail], preferences }) }
  }

  it('honours a default-off channel until the user turns it on', async () => {
    const { preferences, notifier } = setup()
    const report = await notifier.notify({ id: 'u1' }, Digest)
    expect(report.skipped).toEqual(['sms'])
    expect(sent).toEqual(['mail'])

    await preferences.optIn('u1', { notification: 'digest', channel: 'sms' })
    sent.length = 0
    await notifier.notify({ id: 'u1' }, Digest)
    expect(sent).toEqual(['sms', 'mail'])
  })

  it('applies defaults without a preference store, and an inline true turns it on', async () => {
    sent.length = 0
    const notifier = new Notifier({ channels: [sms, mail] })
    expect((await notifier.notify({ id: 'u1' }, Digest)).skipped).toEqual(['sms'])
    expect((await notifier.notify({ id: 'u1', channelPreferences: { sms: true } }, Digest)).skipped).toEqual([])
  })

  it('a mandatory channel ignores stored and inline opt-outs', async () => {
    const { preferences, notifier } = setup()
    await preferences.optOut('u1') // everything off
    const report = await notifier.notify({ id: 'u1', channelPreferences: { mail: false, sms: false } }, Reset)
    expect(report.sent).toEqual([{ channel: 'mail' }])
    expect(report.skipped).toEqual(['sms'])
  })

  describe('a subclass that overrides allowed() keeps deciding (deprecated, minor-compatible)', () => {
    class QuietHours extends NotificationPreferences {
      constructor(private readonly verdict: boolean) {
        super(new MemoryPreferenceStore())
      }
      override async allowed(): Promise<boolean> {
        return this.verdict
      }
    }
    class PreferenceOnly extends NotificationPreferences {
      override async preference(_u: string, _n: string, channel: string): Promise<boolean | undefined> {
        return channel === 'sms' ? true : undefined
      }
    }

    it('an allowed() returning false blocks the channel', async () => {
      sent.length = 0
      const notifier = new Notifier({ channels: [sms, mail], preferences: new QuietHours(false) })
      const report = await notifier.notify({ id: 'u1' }, Digest)
      expect(report.skipped).toEqual(['sms', 'mail'])
      expect(sent).toEqual([])
    })

    it('an allowed() returning true sends even when defaults[channel] is false', async () => {
      sent.length = 0
      const notifier = new Notifier({ channels: [sms, mail], preferences: new QuietHours(true) })
      const report = await notifier.notify({ id: 'u1' }, Digest)
      expect(report.skipped).toEqual([])
      expect(sent).toEqual(['sms', 'mail'])
    })

    it('a subclass overriding only preference() uses the new path', async () => {
      sent.length = 0
      const notifier = new Notifier({
        channels: [sms, mail],
        preferences: new PreferenceOnly(new MemoryPreferenceStore()),
      })
      const report = await notifier.notify({ id: 'u1' }, Digest)
      // sms: preference() says true over defaults.sms false; mail: undefined → default true.
      expect(report.skipped).toEqual([])
      expect(sent).toEqual(['sms', 'mail'])
    })

    it('mandatory channels still bypass an allowed() override', async () => {
      sent.length = 0
      const notifier = new Notifier({ channels: [sms, mail], preferences: new QuietHours(false) })
      const report = await notifier.notify({ id: 'u1' }, Reset)
      expect(report.sent).toEqual([{ channel: 'mail' }])
      expect(report.skipped).toEqual(['sms'])
    })
  })

  it('leaves allowed() unchanged (default allow)', async () => {
    const { preferences } = setup()
    expect(await preferences.allowed('u1', 'digest', 'sms')).toBe(true)
    expect(await preferences.preference('u1', 'digest', 'sms')).toBeUndefined()
  })
})
