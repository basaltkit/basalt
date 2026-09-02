import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedMail } from '@basaltkit/mailer'

/**
 * The driver had no tests at all while it lived in @basaltkit/mailer — the one
 * package of the four extractions that carried none. What it does is map a
 * ResolvedMail onto nodemailer's shape, and the mapping is conditional: empty
 * cc/bcc and absent text/html must be OMITTED, not sent as empty values, since
 * nodemailer treats `{ cc: [] }` and no `cc` differently.
 */

const sent: Record<string, unknown>[] = []
const closed: number[] = []
let lastUrl: string | undefined

vi.mock('nodemailer', () => ({
  createTransport: (url: string) => {
    lastUrl = url
    return {
      sendMail: async (message: Record<string, unknown>) => void sent.push(message),
      close: () => void closed.push(1),
    }
  },
}))

const { SmtpMailDriver, smtpMailer } = await import('../src/index.js')

const mail = (over: Partial<ResolvedMail> = {}): ResolvedMail =>
  ({
    from: 'app@example.com',
    to: ['user@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    text: 'plain',
    ...over,
  }) as ResolvedMail

beforeEach(() => {
  sent.length = 0
  closed.length = 0
  lastUrl = undefined
})

describe('SmtpMailDriver', () => {
  it('hands the URL straight to nodemailer', () => {
    smtpMailer({ url: 'smtp://user:pass@mail.example.com:587' })
    expect(lastUrl).toBe('smtp://user:pass@mail.example.com:587')
  })

  it('identifies itself as "smtp"', () => {
    expect(smtpMailer({ url: 'smtp://localhost:1025' }).name).toBe('smtp')
  })

  it('maps the message onto nodemailer’s shape', async () => {
    await smtpMailer({ url: 'smtp://localhost:1025' }).send(
      mail({ cc: ['cc@example.com'], bcc: ['bcc@example.com'], replyTo: 'reply@example.com', html: '<b>hi</b>' }),
    )
    expect(sent[0]).toEqual({
      from: 'app@example.com',
      to: ['user@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      replyTo: 'reply@example.com',
      subject: 'Hello',
      text: 'plain',
      html: '<b>hi</b>',
    })
  })

  it('omits empty cc/bcc and absent fields rather than sending them empty', async () => {
    // `{ cc: [] }` is not the same as no `cc` to nodemailer, and an `html: undefined`
    // can turn a text mail into an empty-bodied one.
    await smtpMailer({ url: 'smtp://localhost:1025' }).send(mail())
    expect(Object.keys(sent[0]!).sort()).toEqual(['from', 'subject', 'text', 'to'])
    expect(sent[0]).not.toHaveProperty('cc')
    expect(sent[0]).not.toHaveProperty('html')
  })

  it('closes the transport on disconnect', async () => {
    const driver = new SmtpMailDriver({ url: 'smtp://localhost:1025' })
    await driver.disconnect()
    expect(closed).toHaveLength(1)
  })
})
