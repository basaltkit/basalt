import { createTransport, type Transporter } from 'nodemailer'
import type { MailDriver } from '../driver.js'
import type { ResolvedMail } from '../message.js'

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
