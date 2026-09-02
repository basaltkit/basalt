import { createTransport, type Transporter } from 'nodemailer'
import type { MailDriver, ResolvedMail } from '@basaltkit/mailer'

export interface SmtpDriverOptions {
  /** smtp(s)://user:pass@host:port URL, as accepted by nodemailer. */
  url: string
}

export class SmtpMailDriver implements MailDriver {
  readonly name = 'smtp'
  private readonly transporter: Transporter

  constructor(options: SmtpDriverOptions) {
    this.transporter = createTransport(options.url)
  }

  async send(message: ResolvedMail): Promise<void> {
    await this.transporter.sendMail({
      from: message.from,
      to: message.to,
      ...(message.cc.length > 0 ? { cc: message.cc } : {}),
      ...(message.bcc.length > 0 ? { bcc: message.bcc } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      ...(message.text ? { text: message.text } : {}),
      ...(message.html ? { html: message.html } : {}),
    })
  }

  async disconnect(): Promise<void> {
    this.transporter.close()
  }
}

/**
 * An SMTP driver ready for `mailerPlugin({ driver })`.
 *
 * ```ts
 * mailerPlugin({ driver: smtpMailer({ url: 'smtp://localhost:1025' }) })   // Mailpit
 * mailerPlugin({ driver: smtpMailer({ url: process.env.SMTP_URL! }) })
 * ```
 *
 * The `driver: 'smtp'` shorthand this replaces lived in the core, which is why
 * `@basaltkit/mailer` depended on nodemailer and shipped it to every app —
 * including those sending through Resend, SES or Mailgun, which are plain HTTP
 * APIs and need no SMTP client at all.
 */
export function smtpMailer(options: SmtpDriverOptions): SmtpMailDriver {
  return new SmtpMailDriver(options)
}
