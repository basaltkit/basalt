import type { MailDriver } from '../driver.js'
import type { ResolvedMail } from '../message.js'

/** In-memory driver — the test fake. Records everything instead of sending. */
export class MemoryMailDriver implements MailDriver {
  readonly name = 'memory'
  readonly sent: ResolvedMail[] = []

  async send(message: ResolvedMail): Promise<void> {
    this.sent.push(message)
  }

  /** Sent messages for a given mail name. */
  ofMail(name: string): ResolvedMail[] {
    return this.sent.filter((message) => message.mail === name)
  }

  async disconnect(): Promise<void> {}
}
