import type { ResolvedMail } from './message.js'

/** Mail driver contract. Every driver passes the same conformance suite. */
export interface MailDriver {
  readonly name: string
  send(message: ResolvedMail): Promise<void>
  disconnect(): Promise<void>
}
