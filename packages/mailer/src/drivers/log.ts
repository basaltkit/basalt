import type { MailDriver } from '../driver.js'
import type { ResolvedMail } from '../message.js'

/** Development driver: prints the message to a sink instead of sending it. */
export class LogMailDriver implements MailDriver {
  readonly name = 'log'

  constructor(private readonly sink: (line: string) => void = console.log) {}

  async send(message: ResolvedMail): Promise<void> {
    this.sink(
      `[mail] ${message.mail} → ${message.to.join(', ')} | ${message.subject}\n` +
        (message.text ?? message.html ?? '(empty body)'),
    )
  }

  async disconnect(): Promise<void> {}
}
