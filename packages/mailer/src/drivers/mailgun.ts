import type { MailDriver } from '../driver.js'
import { MailDeliveryError, type ResolvedMail } from '../message.js'

export interface MailgunDriverOptions {
  /** Mailgun private API key. */
  apiKey: string
  /** Your sending domain, e.g. `mg.example.com`. */
  domain: string
  /** API region. Default: `us`. */
  region?: 'us' | 'eu'
  /** Override the API base (default derived from `region`). Override in tests. */
  baseUrl?: string
  /** Injectable fetch (for tests). Default: global `fetch`. */
  fetch?: typeof fetch
}

/**
 * Delivers via the [Mailgun](https://mailgun.com) HTTP API — no SDK. Uses Basic
 * auth (`api:<key>`) and a form-encoded body, which covers simple text/HTML
 * messages. The framework's header-injection guard has already validated the
 * envelope.
 */
export class MailgunMailDriver implements MailDriver {
  readonly name = 'mailgun'
  private readonly baseUrl: string
  private readonly doFetch: typeof fetch

  constructor(private readonly options: MailgunDriverOptions) {
    const region = options.region === 'eu' ? 'https://api.eu.mailgun.net/v3' : 'https://api.mailgun.net/v3'
    this.baseUrl = (options.baseUrl ?? region).replace(/\/+$/, '')
    this.doFetch = options.fetch ?? fetch
  }

  async send(message: ResolvedMail): Promise<void> {
    const form = new URLSearchParams()
    form.set('from', message.from)
    form.set('to', message.to.join(', '))
    if (message.cc.length > 0) form.set('cc', message.cc.join(', '))
    if (message.bcc.length > 0) form.set('bcc', message.bcc.join(', '))
    if (message.replyTo) form.set('h:Reply-To', message.replyTo)
    form.set('subject', message.subject)
    if (message.text) form.set('text', message.text)
    if (message.html) form.set('html', message.html)

    const auth = Buffer.from(`api:${this.options.apiKey}`).toString('base64')
    const res = await this.doFetch(`${this.baseUrl}/${this.options.domain}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    if (!res.ok) {
      throw new MailDeliveryError('mailgun', res.status, (await safeText(res)).slice(0, 500))
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
