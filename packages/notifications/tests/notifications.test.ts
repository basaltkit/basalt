import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp } from '@basaltkit/core'
import { mailerPlugin, MemoryMailDriver, Mailer } from '@basaltkit/mailer'
import {
  channel,
  defineNotification,
  InAppChannel,
  IN_APP,
  MailChannel,
  MemoryInAppStore,
  NOTIFIER,
  Notifier,
  notificationsPlugin,
  NotificationValidationError,
  UnknownChannelError,
  type Delivery,
} from '../src/index.js'

const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  schema: z.object({ number: z.string() }),
  channels: ['mail', 'inApp'],
  via: {
    mail: ({ number }) => ({ subject: `Invoice ${number} paid`, text: `Invoice ${number} confirmed.` }),
    inApp: ({ number }) => ({ title: 'Invoice paid', body: `#${number} confirmed`, data: { number } }),
  },
})

const ada = { id: 'u1', email: 'ada@example.com' }

const setup = () => {
  const inApp = new MemoryInAppStore()
  const mailDriver = new MemoryMailDriver()
  const mailer = new Mailer(mailDriver, { from: 'noreply@basalt.dev' })
  const notifier = new Notifier({
    channels: [new InAppChannel(inApp), new MailChannel(mailer)],
  })
  return { inApp, mailDriver, notifier }
}

describe('Notifier', () => {
  it('delivers on every channel with channel-specific rendering', async () => {
    const { inApp, mailDriver, notifier } = setup()
    const report = await notifier.notify(ada, InvoicePaid, { number: 'INV-7' })

    expect(report).toEqual({ sent: [{ channel: 'mail' }, { channel: 'inApp' }], failed: [], skipped: [] })
    expect(mailDriver.sent[0]).toMatchObject({
      to: ['ada@example.com'],
      subject: 'Invoice INV-7 paid',
    })
    const feed = await inApp.list('u1')
    expect(feed[0]).toMatchObject({ title: 'Invoice paid', notification: 'invoice.paid' })
  })

  it('validates data before rendering anything', async () => {
    const { inApp, notifier } = setup()
    await expect(
      notifier.notify(ada, InvoicePaid, { number: 7 as unknown as string }),
    ).rejects.toBeInstanceOf(NotificationValidationError)
    expect(await inApp.list('u1')).toHaveLength(0)
  })

  it('respects per-recipient channel opt-out and dynamic channels', async () => {
    const { inApp, mailDriver, notifier } = setup()
    const optedOut = { ...ada, channelPreferences: { mail: false } }
    const report = await notifier.notify(optedOut, InvoicePaid, { number: 'INV-8' })
    expect(report.skipped).toEqual(['mail'])
    expect(mailDriver.sent).toHaveLength(0)
    expect(await inApp.list('u1')).toHaveLength(1)

    const OnlyInApp = defineNotification({
      name: 'ping',
      channels: (recipient) => (recipient.email ? ['inApp'] : []),
      via: { inApp: () => ({ title: 'ping' }) },
    })
    const dynamic = await notifier.notify(ada, OnlyInApp)
    expect(dynamic.sent).toEqual([{ channel: 'inApp' }])
  })

  it('isolates channel failures and emits notification:failed', async () => {
    const inApp = new MemoryInAppStore()
    const broken = channel('mail', async () => {
      throw new Error('smtp down')
    })
    const app = await createApp({ plugins: [] }).boot()
    const failures: string[] = []
    app.hooks.on('notification:failed', ({ channel: failedChannel }) =>
      void failures.push(failedChannel),
    )
    const notifier = new Notifier({
      channels: [broken, new InAppChannel(inApp)],
      hooks: app.hooks,
    })

    const report = await notifier.notify(ada, InvoicePaid, { number: 'INV-9' })
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.channel).toBe('mail')
    expect(report.sent).toEqual([{ channel: 'inApp' }]) // survived
    expect(failures).toEqual(['mail'])
  })

  it('unknown channel is a configuration error', async () => {
    const notifier = new Notifier({ channels: [] })
    await expect(notifier.notify(ada, InvoicePaid, { number: 'X' })).rejects.toBeInstanceOf(
      UnknownChannelError,
    )
  })

  it('useQueue routes deliveries; deliver() is the worker path', async () => {
    const { inApp, notifier } = setup()
    const queued: Delivery[] = []
    notifier.useQueue(async (delivery) => void queued.push(delivery))

    await notifier.notify(ada, InvoicePaid, { number: 'INV-10' })
    expect(queued).toHaveLength(2)
    expect(await inApp.list('u1')).toHaveLength(0) // nothing sent inline

    for (const delivery of queued) await notifier.deliver(delivery)
    expect(await inApp.list('u1')).toHaveLength(1)
  })

  it('in-app store: unread count and mark as read', async () => {
    const { inApp, notifier } = setup()
    await notifier.notify(ada, InvoicePaid, { number: 'A' })
    await notifier.notify(ada, InvoicePaid, { number: 'B' })

    expect(await inApp.unreadCount('u1')).toBe(2)
    const [latest] = await inApp.list('u1', { limit: 1 })
    expect(await inApp.markRead('u1', latest!.id)).toBe(true)
    expect(await inApp.markRead('u1', latest!.id)).toBe(false) // already read
    expect(await inApp.unreadCount('u1')).toBe(1)
    expect(await inApp.list('u1', { unreadOnly: true })).toHaveLength(1)
  })
})

describe('notificationsPlugin', () => {
  it('wires inApp + mail bridge automatically when the mailer is present', async () => {
    const app = await createApp({
      plugins: [mailerPlugin({ driver: 'memory', from: 'noreply@basalt.dev' }), notificationsPlugin()],
    }).boot()

    const notifier = app.container.get(NOTIFIER)
    const report = await notifier.notify(ada, InvoicePaid, { number: 'INV-11' })
    expect(report.sent.map((sent) => sent.channel).sort()).toEqual(['inApp', 'mail'])
    expect(await app.container.get(IN_APP).unreadCount('u1')).toBe(1)
    await app.shutdown()
  })
})
