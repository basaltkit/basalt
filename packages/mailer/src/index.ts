import { createToken, definePlugin, tryCtx } from '@machize/core'
import type { MailDriver } from './driver.js'
import { LogMailDriver } from './drivers/log.js'
import { MemoryMailDriver } from './drivers/memory.js'
import { SmtpMailDriver, type SmtpDriverOptions } from './drivers/smtp.js'
import {
  MailIncompleteError,
  toList,
  validateMailData,
  type Envelope,
  type MailDefinition,
  type ResolvedMail,
} from './message.js'

export type { MailDriver } from './driver.js'
export { MemoryMailDriver } from './drivers/memory.js'
export { LogMailDriver } from './drivers/log.js'
export { SmtpMailDriver, type SmtpDriverOptions } from './drivers/smtp.js'
export {
  defineMail,
  MailValidationError,
  MailIncompleteError,
  type MailDefinition,
  type MailSchema,
  type Envelope,
  type ResolvedMail,
} from './message.js'

export interface MailerOptions {
  /**
   * Default sender. A function is resolved on every send — use it for
   * tenant-aware branding (e.g. read ctx().tenant): `() => currentTenantFrom()`.
   */
  from?: string | (() => string | undefined)
  replyTo?: string
}

export class Mailer {
  /** When set, send() hands the resolved message off (e.g. to a queue job). */
  private enqueue: ((message: ResolvedMail) => Promise<void>) | undefined

  constructor(
    private readonly driver: MailDriver,
    private readonly options: MailerOptions = {},
  ) {}

  /**
   * Routes deliveries through a dispatcher instead of sending inline —
   * typically a @machize/queue job that calls mailer.deliver(message):
   *
   * const SendMail = defineJob({ name: 'mailer.send', handle: (m) => mailer.deliver(m) })
   * mailer.useQueue((m) => SendMail.dispatch(m))
   */
  useQueue(dispatch: (message: ResolvedMail) => Promise<void>): this {
    this.enqueue = dispatch
    return this
  }

  /** Renders and sends (or enqueues) a typed mail. */
  async send<T>(
    mail: MailDefinition<T>,
    ...rest: T extends void ? [envelope: Envelope] : [data: T, envelope: Envelope]
  ): Promise<void> {
    const [data, envelope] = (rest.length === 1 ? [undefined, rest[0]] : rest) as [T, Envelope]
    const message = this.resolve(mail, data, envelope)
    if (this.enqueue) return this.enqueue(message)
    return this.driver.send(message)
  }

  /** Sends a resolved message directly through the driver — used by queue workers. */
  async deliver(message: ResolvedMail): Promise<void> {
    return this.driver.send(message)
  }

  /** Renders a mail without sending — used by tests and the future preview server. */
  resolve<T>(mail: MailDefinition<T>, data: T, envelope: Envelope): ResolvedMail {
    const validated = validateMailData(mail, data)

    const to = toList(envelope.to)
    if (to.length === 0) throw new MailIncompleteError('to')

    const from = envelope.from ?? this.defaultFrom()
    if (!from) throw new MailIncompleteError('from')

    const replyTo = envelope.replyTo ?? this.options.replyTo
    return {
      mail: mail.name,
      to,
      from,
      cc: toList(envelope.cc),
      bcc: toList(envelope.bcc),
      replyTo,
      subject: mail.subject(validated),
      text: mail.text?.(validated),
      html: mail.html?.(validated),
    }
  }

  private defaultFrom(): string | undefined {
    const { from } = this.options
    return typeof from === 'function' ? from() : from
  }
}

/** Default tenant-aware sender: reads `ctx().tenant.mailFrom` when present. */
export const tenantFrom =
  (fallback?: string) =>
  (): string | undefined => {
    const tenant = tryCtx()?.['tenant'] as { mailFrom?: string } | undefined
    return tenant?.mailFrom ?? fallback
  }

export const MAILER = createToken<Mailer>('mailer')

export interface MailerPluginOptions extends MailerOptions {
  driver?: 'smtp' | 'log' | 'memory'
  /** Required with the 'smtp' driver. */
  smtp?: SmtpDriverOptions
  /** Sink for the 'log' driver. Default: console.log */
  sink?: (line: string) => void
}

export function mailerPlugin(options: MailerPluginOptions = {}) {
  let driver: MailDriver | undefined
  return definePlugin({
    name: 'machize:mailer',
    register({ container }) {
      container.singleton(MAILER, () => {
        driver =
          options.driver === 'smtp'
            ? new SmtpMailDriver(options.smtp as SmtpDriverOptions)
            : options.driver === 'memory'
              ? new MemoryMailDriver()
              : new LogMailDriver(options.sink)
        return new Mailer(driver, options)
      })
    },
    async shutdown() {
      await driver?.disconnect()
    },
  })
}
