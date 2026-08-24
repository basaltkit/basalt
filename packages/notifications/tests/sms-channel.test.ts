import { describe, it, expect } from 'vitest'
import {
  SmsChannel,
  whatsappChannel,
  RecipientPhoneMissingError,
  type SmsSender,
} from '../src/index.js'
import type { Notifiable } from '../src/definition.js'

const recorder = () => {
  const sent: Array<{ to: string; from?: string; body: string }> = []
  const sender: SmsSender = { send: async (m) => void sent.push(m) }
  return { sent, sender }
}
const info = { notification: 'welcome' }

describe('SmsChannel', () => {
  it('sends to the recipient phone with the default sender id', async () => {
    const { sent, sender } = recorder()
    const channel = new SmsChannel(sender, { from: '+15550000' })
    const recipient: Notifiable = { id: 'u1', phone: '+244923111222' }
    await channel.send(recipient, { body: 'Hi!' }, info)
    expect(channel.name).toBe('sms')
    expect(sent).toEqual([{ to: '+244923111222', from: '+15550000', body: 'Hi!' }])
  })

  it('lets a message override the sender id, and omits from when absent', async () => {
    const { sent, sender } = recorder()
    const channel = new SmsChannel(sender)
    await channel.send({ id: 'u1', phone: '+1' }, { body: 'x', from: '+override' }, info)
    expect(sent[0]).toEqual({ to: '+1', from: '+override', body: 'x' })
    await channel.send({ id: 'u2', phone: '+2' }, { body: 'y' }, info)
    expect(sent[1]).toEqual({ to: '+2', body: 'y' }) // no from key at all
  })

  it('throws when the recipient has no address', async () => {
    const { sender } = recorder()
    const channel = new SmsChannel(sender)
    await expect(channel.send({ id: 'u9' }, { body: 'x' }, info)).rejects.toBeInstanceOf(
      RecipientPhoneMissingError,
    )
  })

  it('a custom toAddress overrides where the number comes from', async () => {
    const { sent, sender } = recorder()
    const channel = new SmsChannel(sender, { toAddress: (r) => r['mobile'] as string })
    await channel.send({ id: 'u1', mobile: '+999' }, { body: 'x' }, info)
    expect(sent[0]?.to).toBe('+999')
  })
})

describe('whatsappChannel', () => {
  it('names the channel whatsapp and prefers the whatsapp address', async () => {
    const { sent, sender } = recorder()
    const channel = whatsappChannel(sender, { from: 'whatsapp:+15550000' })
    expect(channel.name).toBe('whatsapp')
    await channel.send({ id: 'u1', whatsapp: 'whatsapp:+244923', phone: '+244923' }, { body: 'Hi' }, info)
    expect(sent[0]).toEqual({ to: 'whatsapp:+244923', from: 'whatsapp:+15550000', body: 'Hi' })
  })

  it('falls back to phone when no whatsapp address is set', async () => {
    const { sent, sender } = recorder()
    const channel = whatsappChannel(sender)
    await channel.send({ id: 'u1', phone: '+244923' }, { body: 'Hi' }, info)
    expect(sent[0]?.to).toBe('+244923')
  })
})
