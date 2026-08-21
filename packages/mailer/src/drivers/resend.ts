import type { MailDriver } from '../driver.js'
import { MailDeliveryError, type ResolvedMail } from '../message.js'

export interface ResendDriverOptions {
  /** Resend API key (`re_…`). */
  apiKey: string
  /** API base URL. Default: `https://api.resend.com`. Override in tests. */
  baseUrl?: string
  /** Injectable fetch (for tests / custom agents). Default: global `fetch`. */
  fetch?: typeof fetch
}

/**
 * Delivers via the [Resend](https://resend.com) HTTP API — no SDK, just `fetch`.
 * The framework's single header-injection guard has already validated the
 * envelope, so the fields here are safe to forward as-is.
 */
export class ResendMailDriver implements MailDriver {
  readonly name = 'resend'
  private readonly baseUrl: string
  private readonly doFetch: typeof fetch

  constructor(private readonly options: ResendDriverOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '')
    this.doFetch = options.fetch ?? fetch
  }

  async send(message: ResolvedMail): Promise<void> {
    const body = {
      from: message.from,
      to: message.to,
      ...(message.cc.length > 0 ? { cc: message.cc } : {}),
      ...(message.bcc.length > 0 ? { bcc: message.bcc } : {}),
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      subject: message.subject,
      ...(message.text ? { text: message.text } : {}),
      ...(message.html ? { html: message.html } : {}),
    }
    const res = await this.doFetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new MailDeliveryError('resend', res.status, (await safeText(res)).slice(0, 500))
    }
  }

  async disconnect(): Promise<void> {
    /* stateless HTTP driver — nothing to close */
  }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
