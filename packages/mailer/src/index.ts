import { createToken, definePlugin, ensureMetadata, tryCtx } from '@basaltkit/core'
import type { MailDriver } from './driver.js'
import { LogMailDriver } from './drivers/log.js'
import { MemoryMailDriver } from './drivers/memory.js'
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

export { escapeHtml, html, raw, SafeHtml } from './html.js'
export type { MailDriver } from './driver.js'
export { MemoryMailDriver } from './drivers/memory.js'
export { LogMailDriver, type LogMailDriverOptions } from './drivers/log.js'
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
    // A message that round-tripped through a queue is re-checked before it
    // reaches the driver — same header-injection guard as the send() path.
    assertHeaderSafe(message)
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
    // A mail's html field may return the SafeHtml from an `html\`\`` template;
    // normalize to a string before layout/driver (SafeHtml stringifies to its
    // markup).
    const rawHtmlValue = mail.html?.(validated)
    const rawHtml = rawHtmlValue === undefined ? undefined : String(rawHtmlValue)
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
  /**
   * A built-in driver by name, or any `MailDriver` instance.
   *
   * SMTP used to be reachable here as `'smtp'`, which is why this package
   * depended on nodemailer and shipped it to every app — including those on
   * Resend, SES or Mailgun, which are plain HTTP APIs needing no SMTP client.
   * Use `smtpMailer({ host })` from `@basaltkit/mailer-smtp` instead.
   *
   * The instance form is also how a driver of your own plugs in; before this
   * there was no way to supply one.
   */
  driver?: 'log' | 'memory' | 'resend' | 'ses' | 'mailgun' | MailDriver
  /** Required with the 'resend' driver. */
  resend?: ResendDriverOptions
  /** Required with the 'ses' driver. */
  ses?: SesDriverOptions
  /** Required with the 'mailgun' driver. */
  mailgun?: MailgunDriverOptions
  /** Sink for the 'log' driver. Default: console.log */
  sink?: (line: string) => void
  /**
   * 'log' driver only: include the full message body in the log line. Default:
   * true outside production, false in production (bodies carry reset links and
   * tokens that must not be retained by log aggregators).
   */
  logBody?: boolean
  /**
   * Mails to expose through the `mail:preview` CLI command (a browser dev
   * server). Each carries sample data; the preview reuses the mailer's own
   * schema validation and `layout`.
   */
  previews?: MailPreview[]
}

// Fail loud on a typo'd/unrecognized driver name: silently falling back to the
// log driver would print every outbound mail (reset links included) to stdout.
function createDriver(options: MailerPluginOptions): MailDriver {
  // An instance wins outright — that is how @basaltkit/mailer-smtp and any
  // driver you write plug in.
  if (typeof options.driver === 'object') return options.driver
  switch (options.driver ?? 'log') {
    case 'resend':
      return new ResendMailDriver(options.resend as ResendDriverOptions)
    case 'ses':
      return new SesMailDriver(options.ses as SesDriverOptions)
    case 'mailgun':
      return new MailgunMailDriver(options.mailgun as MailgunDriverOptions)
    case 'memory':
      return new MemoryMailDriver()
    case 'log':
      return new LogMailDriver(options.sink, options.logBody !== undefined ? { logBody: options.logBody } : {})
    default:
      // TypeScript already rejects `'smtp'`, but a JS caller or an untyped
      // config file will not — so name the move rather than calling it unknown.
      if (options.driver === ('smtp' as unknown)) {
        throw new Error(
          "The 'smtp' driver moved to @basaltkit/mailer-smtp. Install it and pass an instance: " +
            'mailerPlugin({ driver: smtpMailer({ host, port }) }). It left the core so apps on ' +
            'Resend, SES or Mailgun stop installing nodemailer.',
        )
      }
      throw new Error(
        `Unknown mail driver "${String(options.driver)}". Valid drivers: resend, ses, mailgun, memory, log — ` +
          'or a MailDriver instance, e.g. smtpMailer() from @basaltkit/mailer-smtp.',
      )
  }
}

export function mailerPlugin(options: MailerPluginOptions = {}) {
  let driver: MailDriver | undefined
  return definePlugin({
    name: 'basalt:mailer',
    register({ container }) {
      registerPreviewCommand(container, options)
      container.singleton(MAILER, () => {
        driver = createDriver(options)
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
