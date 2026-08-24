import { describe, expect, it } from 'vitest'
import {
  Notifier,
  channel,
  defineNotification,
  NotificationPreferences,
  MemoryPreferenceStore,
} from '../src/index.js'

const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  channels: ['sms', 'mail'],
  via: { sms: () => 'sms-msg', mail: () => 'mail-msg' },
})

const makeNotifier = () => {
  const sent: string[] = []
  const sms = channel('sms', async (r) => { sent.push(`sms:${r.id}`) })
  const mail = channel('mail', async (r) => { sent.push(`mail:${r.id}`) })
  const prefs = new NotificationPreferences(new MemoryPreferenceStore())
  return { notifier: new Notifier({ channels: [sms, mail], preferences: prefs }), prefs, sent }
}

describe('NotificationPreferences', () => {
  it('is allowed by default, and honours channel-wide opt-out', async () => {
    const prefs = new NotificationPreferences(new MemoryPreferenceStore())
    expect(await prefs.allowed('u', 'invoice.paid', 'sms')).toBe(true)
    await prefs.optOut('u', { channel: 'sms' })
    expect(await prefs.allowed('u', 'invoice.paid', 'sms')).toBe(false)
    expect(await prefs.allowed('u', 'invoice.paid', 'mail')).toBe(true)
  })

  it('the most specific preference wins (opt-in overrides a global opt-out)', async () => {
    const prefs = new NotificationPreferences(new MemoryPreferenceStore())
    await prefs.optOut('u', {}) // everything off
    expect(await prefs.allowed('u', 'invoice.paid', 'sms')).toBe(false)
    await prefs.optIn('u', { notification: 'invoice.paid', channel: 'sms' })
    expect(await prefs.allowed('u', 'invoice.paid', 'sms')).toBe(true) // specific beats global
    expect(await prefs.allowed('u', 'invoice.paid', 'mail')).toBe(false) // still off
  })

  it('notify() skips channels the user opted out of', async () => {
    const { notifier, prefs, sent } = makeNotifier()
    await prefs.optOut('u1', { notification: 'invoice.paid', channel: 'sms' })

    const report = await notifier.notify({ id: 'u1' }, InvoicePaid)
    expect(report.sent.map((s) => s.channel)).toEqual(['mail'])
    expect(report.skipped).toEqual(['sms'])
    expect(sent).toEqual(['mail:u1'])
  })
})
