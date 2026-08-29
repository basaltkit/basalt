import type { MailDriver } from '../driver.js'
import type { ResolvedMail } from '../message.js'

export interface LogMailDriverOptions {
  /**
   * Include the full message body in the log line. Default: `true` outside
   * production, `false` in production — mail bodies routinely carry password
   * reset links, magic links and tokens, which must not end up retained by a
   * log aggregator because a deploy was left on the default driver.
   */
  logBody?: boolean
}

/** Development driver: prints the message to a sink instead of sending it. */
export class LogMailDriver implements MailDriver {
  readonly name = 'log'
  private readonly logBody: boolean

  constructor(
    private readonly sink: (line: string) => void = console.log,
    options: LogMailDriverOptions = {},
  ) {
    this.logBody = options.logBody ?? process.env['NODE_ENV'] !== 'production'
  }

  async send(message: ResolvedMail): Promise<void> {
    const body = this.logBody
      ? (message.text ?? message.html ?? '(empty body)')
      : '(body redacted in production — pass `logBody: true` to log it, or configure a real driver)'
    this.sink(`[mail] ${message.mail} → ${message.to.join(', ')} | ${message.subject}\n` + body)
  }

  async disconnect(): Promise<void> {}
}
