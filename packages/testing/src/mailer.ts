import { createToken, definePlugin, MachizeError } from '@machize/core'
import {
  MAILER,
  Mailer,
  MemoryMailDriver,
  type MailDefinition,
  type MailerOptions,
  type ResolvedMail,
} from '@machize/mailer'

export class MailAssertionError extends MachizeError {
  constructor(message: string) {
    super('TEST_MAIL_ASSERTION', message)
  }
}

export interface FakeMailer {
  /** Register this in createTestApp({ plugins: [mail.plugin, ...] }). */
  plugin: ReturnType<typeof definePlugin>
  /** Everything "sent", in order. */
  sent: ResolvedMail[]
  assertSent(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test boundary
    mail: MailDefinition<any> | string,
    predicate?: (message: ResolvedMail) => boolean,
  ): ResolvedMail
  assertNothingSent(): void
}

/** Mail fake: records instead of sending, with Laravel-style assertions. */
export function fakeMailer(options: MailerOptions = { from: 'test@machize.dev' }): FakeMailer {
  const driver = new MemoryMailDriver()
  const plugin = definePlugin({
    name: 'machize:mailer',
    register({ container }) {
      container.singleton(MAILER, () => new Mailer(driver, options))
    },
  })

  return {
    plugin,
    sent: driver.sent,
    assertSent(mail, predicate) {
      const name = typeof mail === 'string' ? mail : mail.name
      const matches = driver.sent.filter(
        (message) => message.mail === name && (predicate ? predicate(message) : true),
      )
      if (matches.length === 0) {
        const seen = driver.sent.map((message) => message.mail).join(', ') || '(nothing)'
        throw new MailAssertionError(
          `Expected mail "${name}" to have been sent${predicate ? ' matching the predicate' : ''}. Sent: ${seen}`,
        )
      }
      return matches[0] as ResolvedMail
    },
    assertNothingSent() {
      if (driver.sent.length > 0) {
        throw new MailAssertionError(
          `Expected no mail, but ${driver.sent.length} message(s) were sent: ${driver.sent
            .map((message) => message.mail)
            .join(', ')}`,
        )
      }
    },
  }
}

export const FAKE_MAILER = createToken<FakeMailer>('testing:mailer')
