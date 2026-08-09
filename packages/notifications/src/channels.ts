import { randomUUID } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { MailDefinition, Mailer } from '@basaltkit/mailer'
import type { Notifiable } from './definition.js'

/** Channel driver contract — sms/push/whatsapp arrive as implementations of this. */
export interface NotificationChannel {
  readonly name: string
  send(
    recipient: Notifiable,
    message: unknown,
    info: { notification: string },
  ): Promise<void>
}

/** Inline helper for custom channels: `channel('sms', async (r, m) => …)`. */
export function channel(
  name: string,
  send: NotificationChannel['send'],
): NotificationChannel {
  return { name, send }
}

// ---------------------------------------------------------------- in-app

export interface InAppNotification {
  readonly id: string
  readonly recipientId: string
  readonly notification: string
  readonly title: string
  readonly body?: string | undefined
  readonly data?: unknown
  readAt?: number
  readonly at: number
}

export interface InAppStore {
  append(record: InAppNotification): Promise<void>
  list(
    recipientId: string,
    options?: { unreadOnly?: boolean; limit?: number },
  ): Promise<InAppNotification[]>
  markRead(recipientId: string, id: string): Promise<boolean>
  unreadCount(recipientId: string): Promise<number>
}

export class MemoryInAppStore implements InAppStore {
  private readonly records: InAppNotification[] = []

  async append(record: InAppNotification): Promise<void> {
    this.records.push(record)
  }

  async list(
    recipientId: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<InAppNotification[]> {
    const results = this.records
      .filter(
        (record) =>
          record.recipientId === recipientId &&
          (!options.unreadOnly || record.readAt === undefined),
      )
      .reverse()
    return options.limit !== undefined ? results.slice(0, options.limit) : results
  }

  async markRead(recipientId: string, id: string): Promise<boolean> {
    const record = this.records.find(
      (candidate) => candidate.id === id && candidate.recipientId === recipientId,
    )
    if (!record || record.readAt !== undefined) return false
    record.readAt = Date.now()
    return true
  }

  async unreadCount(recipientId: string): Promise<number> {
    return (await this.list(recipientId, { unreadOnly: true })).length
  }
}

export interface InAppMessage {
  title: string
  body?: string
  data?: unknown
}

export class InAppChannel implements NotificationChannel {
  readonly name = 'inApp'

  constructor(private readonly store: InAppStore) {}

  async send(
    recipient: Notifiable,
    message: unknown,
    info: { notification: string },
  ): Promise<void> {
    const inApp = message as InAppMessage
    await this.store.append({
      id: randomUUID(),
      recipientId: recipient.id,
      notification: info.notification,
      title: inApp.title,
      body: inApp.body,
      data: inApp.data,
      at: Date.now(),
    })
  }
}

// ---------------------------------------------------------------- mail

export class RecipientEmailMissingError extends BasaltError {
  constructor(recipientId: string) {
    super(
      'NOTIFICATION_EMAIL_MISSING',
      `Recipient "${recipientId}" has no email — cannot deliver on the mail channel.`,
    )
  }
}

export interface MailChannelMessage {
  subject: string
  text?: string
  html?: string
}

/** Bridges the mail channel to @basaltkit/mailer (queue/tenant-sender included). */
export class MailChannel implements NotificationChannel {
  readonly name = 'mail'

  constructor(private readonly mailer: Mailer) {}

  async send(
    recipient: Notifiable,
    message: unknown,
    info: { notification: string },
  ): Promise<void> {
    if (!recipient.email) throw new RecipientEmailMissingError(recipient.id)
    const mail = message as MailChannelMessage
    const definition: MailDefinition<void> = {
      name: `notification:${info.notification}`,
      subject: () => mail.subject,
      ...(mail.text !== undefined ? { text: () => mail.text as string } : {}),
      ...(mail.html !== undefined ? { html: () => mail.html as string } : {}),
    }
    await this.mailer.send(definition, { to: recipient.email })
  }
}
