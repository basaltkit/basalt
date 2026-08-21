import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createApp, runWithContext } from '@basaltkit/core'
import {
  defineMail,
  LogMailDriver,
  MAILER,
  Mailer,
  mailerPlugin,
  MailValidationError,
  MemoryMailDriver,
  tenantFrom,
  type ResolvedMail,
} from '../src/index.js'

const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
  html: ({ name }) => `<h1>Hello ${name}</h1>`,
})

const setup = (options = {}) => {
  const driver = new MemoryMailDriver()
  const mailer = new Mailer(driver, { from: 'noreply@basalt.dev', ...options })
  return { driver, mailer }
}

describe('Mailer', () => {
  it('renders and sends a typed mail with defaults applied', async () => {
    const { driver, mailer } = setup({ replyTo: 'support@basalt.dev' })
    await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })

    expect(driver.sent).toHaveLength(1)
    expect(driver.sent[0]).toMatchObject({
      mail: 'welcome',
      to: ['ada@example.com'],
      from: 'noreply@basalt.dev',
      replyTo: 'support@basalt.dev',
      subject: 'Welcome, Ada!',
      text: 'Hello Ada',
      html: '<h1>Hello Ada</h1>',
    })
  })

  it('validates mail data before rendering', async () => {
    const { driver, mailer } = setup()
    await expect(
      mailer.send(WelcomeEmail, { name: 1 as unknown as string }, { to: 'a@b.c' }),
    ).rejects.toBeInstanceOf(MailValidationError)
    expect(driver.sent).toHaveLength(0)
  })

  it('requires recipient and sender with typed errors', async () => {
    const { mailer } = setup({ from: undefined })
    await expect(mailer.send(WelcomeEmail, { name: 'A' }, { to: [] })).rejects.toMatchObject({
      code: 'MAIL_INCOMPLETE',
    })
    await expect(mailer.send(WelcomeEmail, { name: 'A' }, { to: 'a@b.c' })).rejects.toMatchObject({
      code: 'MAIL_INCOMPLETE',
    })
  })

  it('resolves the sender per tenant via context', async () => {
    const { driver, mailer } = setup({ from: tenantFrom('fallback@basalt.dev') })

    await runWithContext({ tenant: { id: 'acme', mailFrom: 'hello@acme.com' } }, () =>
      mailer.send(WelcomeEmail, { name: 'A' }, { to: 'x@y.z' }),
    )
    await mailer.send(WelcomeEmail, { name: 'B' }, { to: 'x@y.z' })

    expect(driver.sent.map((message) => message.from)).toEqual([
      'hello@acme.com',
      'fallback@basalt.dev',
    ])
  })

  it('useQueue routes send() to the dispatcher while deliver() hits the driver', async () => {
    const { driver, mailer } = setup()
    const queued: ResolvedMail[] = []
    mailer.useQueue(async (message) => void queued.push(message))

    await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'a@b.c' })
    expect(driver.sent).toHaveLength(0)
    expect(queued).toHaveLength(1)

    // what a queue worker does with the enqueued message
    await mailer.deliver(queued[0] as ResolvedMail)
    expect(driver.sent).toHaveLength(1)
  })

  it('supports mails without data', async () => {
    const { driver, mailer } = setup()
    const Ping = defineMail({ name: 'ping', subject: () => 'Ping', text: () => 'pong' })
    await mailer.send(Ping, { to: 'a@b.c' })
    expect(driver.sent[0]).toMatchObject({ subject: 'Ping', text: 'pong' })
  })

  it('log driver writes a readable line to the sink', async () => {
    const lines: string[] = []
    const mailer = new Mailer(new LogMailDriver((line) => void lines.push(line)), {
      from: 'noreply@basalt.dev',
    })
    await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })
    expect(lines[0]).toContain('welcome')
    expect(lines[0]).toContain('ada@example.com')
    expect(lines[0]).toContain('Welcome, Ada!')
  })

  it('rejects a subject carrying CRLF header injection', async () => {
    const { driver, mailer } = setup()
    const Evil = defineMail({
      name: 'evil-subject',
      subject: () => 'Hi\r\nBcc: evil@x.com',
      text: () => 'body',
    })
    await expect(mailer.send(Evil, { to: 'ada@example.com' })).rejects.toMatchObject({
      code: 'MAIL_HEADER_INJECTION',
      field: 'subject',
      status: 400,
    })
    expect(driver.sent).toHaveLength(0)
  })

  it('rejects a recipient address containing a newline', async () => {
    const { driver, mailer } = setup()
    await expect(
      mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com\nBcc: evil@x.com' }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'to' })
    expect(driver.sent).toHaveLength(0)
  })

  it('rejects injection in cc, bcc, replyTo and from too', async () => {
    const { mailer } = setup()
    await expect(
      mailer.send(WelcomeEmail, { name: 'A' }, { to: 'a@b.c', cc: 'x@y.z\r\nBcc: e@x.com' }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'cc' })
    await expect(
      mailer.send(WelcomeEmail, { name: 'A' }, { to: 'a@b.c', bcc: ['ok@x.com', 'bad\n@x.com'] }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'bcc' })
    await expect(
      mailer.send(WelcomeEmail, { name: 'A' }, { to: 'a@b.c', replyTo: 'r@x.com\rSubject: x' }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'replyTo' })

    const bad = new Mailer(new MemoryMailDriver(), { from: 'noreply\n@x.com' })
    await expect(
      bad.send(WelcomeEmail, { name: 'A' }, { to: 'a@b.c' }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'from' })
  })

  it('rejects a malformed address with no @ or spaces in the addr-spec', async () => {
    const { mailer } = setup()
    await expect(
      mailer.send(WelcomeEmail, { name: 'A' }, { to: 'not-an-email' }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'to' })
    await expect(
      mailer.send(WelcomeEmail, { name: 'A' }, { to: 'spaced @example.com' }),
    ).rejects.toMatchObject({ code: 'MAIL_HEADER_INJECTION', field: 'to' })
  })

  it('still builds a normal message, including a display-name address', async () => {
    const { driver, mailer } = setup({ replyTo: 'support@basalt.dev' })
    await mailer.send(
      WelcomeEmail,
      { name: 'Ada' },
      {
        to: '"Ada Lovelace" <ada@example.com>',
        cc: ['Bob <bob@example.com>', 'carol@example.com'],
        from: 'Basalt <noreply@basalt.dev>',
      },
    )
    expect(driver.sent).toHaveLength(1)
    expect(driver.sent[0]).toMatchObject({
      to: ['"Ada Lovelace" <ada@example.com>'],
      cc: ['Bob <bob@example.com>', 'carol@example.com'],
      from: 'Basalt <noreply@basalt.dev>',
      subject: 'Welcome, Ada!',
    })
  })

  it('mailerPlugin registers the token with the chosen driver', async () => {
    const app = await createApp({
      plugins: [mailerPlugin({ driver: 'memory', from: 'noreply@basalt.dev' })],
    }).boot()
    const mailer = app.container.get(MAILER)
    await mailer.send(WelcomeEmail, { name: 'A' }, { to: 'a@b.c' })
    await app.shutdown()
  })
})
