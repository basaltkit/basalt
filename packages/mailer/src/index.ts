import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import type { MailDriver } from './driver.js'
import { LogMailDriver } from './drivers/log.js'
import { MemoryMailDriver } from './drivers/memory.js'
import { SmtpMailDriver, type SmtpDriverOptions } from './drivers/smtp.js'
import { ResendMailDriver, type ResendDriverOptions } from './drivers/resend.js'
import { SesMailDriver, type SesDriverOptions } from './drivers/ses.js'
import { MailgunMailDriver, type MailgunDriverOptions } from './drivers/mailgun.js'
import { createMailPreviewServer, type MailPreview } from './preview.js'
import {
  assertHeaderSafe,
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
export { ResendMailDriver, type ResendDriverOptions } from './drivers/resend.js'
export { SesMailDriver, type SesDriverOptions } from './drivers/ses.js'
export { MailgunMailDriver, type MailgunDriverOptions } from './drivers/mailgun.js'
export {
  createMailPreviewServer,
  definePreview,
  renderPreviewResponse,
  type MailPreview,
  type MailPreviewOptions,
  type MailPreviewServer,
  type PreviewResponse,
} from './preview.js'
export {
  defineMail,
  MailValidationError,
  MailIncompleteError,
  MailHeaderInjectionError,
  MailDeliveryError,
  assertHeaderSafe,
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
  /**
   * Wraps every rendered HTML body in a shared layout (branding, header/footer).
   * Called with the mail's own HTML and its context; return the full document.
   * Read `ctx().tenant` inside for per-tenant branding. Only applied when the
   * mail has an HTML body. Any template engine (MJML, React Email, Handlebars…)
   * can be used here — or inside a mail's own `html()`.
   */
  layout?: (html: string, context: { mail: string; data: unknown }) => string
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
   * typically a @basaltkit/queue job that calls mailer.deliver(message):
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
    const rawHtml = mail.html?.(validated)
    // Wrap the body in the shared layout (branding), when one is configured.
    const html =
      rawHtml !== undefined && this.options.layout
        ? this.options.layout(rawHtml, { mail: mail.name, data: validated })
        : rawHtml
    const message: ResolvedMail = {
      mail: mail.name,
      to,
      from,
      cc: toList(envelope.cc),
      bcc: toList(envelope.bcc),
      replyTo,
      subject: mail.subject(validated),
      text: mail.text?.(validated),
      html,
    }
    // Single header-injection choke point: guards every driver, not just SMTP.
    assertHeaderSafe(message)
    return message
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
  driver?: 'smtp' | 'log' | 'memory' | 'resend' | 'ses' | 'mailgun'
  /** Required with the 'smtp' driver. */
  smtp?: SmtpDriverOptions
  /** Required with the 'resend' driver. */
  resend?: ResendDriverOptions
  /** Required with the 'ses' driver. */
  ses?: SesDriverOptions
  /** Required with the 'mailgun' driver. */
  mailgun?: MailgunDriverOptions
  /** Sink for the 'log' driver. Default: console.log */
  sink?: (line: string) => void
  /**
   * Mails to expose through the `mail:preview` CLI command (a browser dev
   * server). Each carries sample data; the preview reuses the mailer's own
   * schema validation and `layout`.
   */
  previews?: MailPreview[]
}

export function mailerPlugin(options: MailerPluginOptions = {}) {
  let driver: MailDriver | undefined
  return definePlugin({
    name: 'basalt:mailer',
    register({ container }) {
      registerPreviewCommand(container, options)
      container.singleton(MAILER, () => {
        driver =
          options.driver === 'smtp'
            ? new SmtpMailDriver(options.smtp as SmtpDriverOptions)
            : options.driver === 'resend'
              ? new ResendMailDriver(options.resend as ResendDriverOptions)
              : options.driver === 'ses'
                ? new SesMailDriver(options.ses as SesDriverOptions)
                : options.driver === 'mailgun'
                  ? new MailgunMailDriver(options.mailgun as MailgunDriverOptions)
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

/**
 * Registers the `mail:preview` command into the CLI command bucket when the app
 * declares previews. The command boots {@link createMailPreviewServer} and stays
 * up until interrupted — `basalt mail:preview [--port=3737]`.
 */
function registerPreviewCommand(
  container: Parameters<NonNullable<ReturnType<typeof definePlugin>['register']>>[0]['container'],
  options: MailerPluginOptions,
): void {
  const previews = options.previews
  if (!previews || previews.length === 0) return
  ensureMetadata(container).add('commands', {
    name: 'mail:preview',
    description: 'Serve a browser preview of the app\'s mails',
    async handle({ io, flags }: { io: { log(m: string): void }; flags: Record<string, string | boolean> }) {
      const port = typeof flags['port'] === 'string' ? Number(flags['port']) : 3737
      const server = createMailPreviewServer(previews, {
        ...(typeof options.from === 'string' ? { from: options.from } : {}),
        ...(options.layout ? { layout: options.layout } : {}),
      })
      const { url } = await server.listen(port)
      io.log(`Mail preview running at ${url} (${previews.length} mails) \u2014 Ctrl+C to stop`)
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => {
          void server.close().then(resolve)
        })
      })
    },
  })
}
