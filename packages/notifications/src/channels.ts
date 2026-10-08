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
  /**
   * Collapses repeated notifications into one inbox row: while a row with the
   * same recipient and `groupKey` is still unread, a new one bumps its `count`
   * instead of adding a row (see {@link InAppStore.upsertGroup}).
   */
  readonly groupKey?: string | undefined
  /** How many notifications this row stands for. Absent means 1. */
  readonly count?: number | undefined
}

/** What {@link InAppStore.prune} deletes. Each bound is an epoch-ms cut-off. */
export interface InAppPruneOptions {
  /** Delete read notifications whose `readAt` is older than this. */
  readBefore?: number
  /** Delete unread notifications whose `at` is older than this. */
  unreadBefore?: number
}

/**
 * Where in-app notifications live. The four required methods are the original
 * contract; the optional ones are capabilities a store may add. Callers check
 * for them (`store.markAllRead?.(...)`) and fall back when they are missing, so
 * a store written against the older contract keeps working unchanged.
 */
export interface InAppStore {
  append(record: InAppNotification): Promise<void>
  list(
    recipientId: string,
    options?: { unreadOnly?: boolean; limit?: number },
  ): Promise<InAppNotification[]>
  markRead(recipientId: string, id: string): Promise<boolean>
  unreadCount(recipientId: string): Promise<number>
  /** Marks every unread notification of a recipient read, in one operation. Returns how many changed. */
  markAllRead?(recipientId: string): Promise<number>
  /**
   * Deletes old notifications across all recipients — the retention job. A
   * bound that is left out deletes nothing on that side; with neither bound
   * nothing is deleted. Returns how many rows were removed.
   */
  prune?(options: InAppPruneOptions): Promise<number>
  /**
   * Appends `record`, or collapses it onto the recipient's still-unread row
   * with the same `groupKey`: that row's `count` goes up by one and it takes
   * the new title, body, data and `at` (so it sorts as the newest). Once the
   * row is read, the next notification of the group starts a new row.
   */
  upsertGroup?(record: InAppNotification & { groupKey: string }): Promise<void>
}

export class MemoryInAppStore implements InAppStore {
  private records: InAppNotification[] = []

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

  async markAllRead(recipientId: string): Promise<number> {
    const now = Date.now()
    let marked = 0
    for (const record of this.records) {
      if (record.recipientId === recipientId && record.readAt === undefined) {
        record.readAt = now
        marked++
      }
    }
    return marked
  }

  async prune(options: InAppPruneOptions): Promise<number> {
    const before = this.records.length
    this.records = this.records.filter((record) => !isPrunable(record, options))
    return before - this.records.length
  }

  async upsertGroup(record: InAppNotification & { groupKey: string }): Promise<void> {
    const index = this.records.findIndex(
      (candidate) =>
        candidate.recipientId === record.recipientId &&
        candidate.groupKey === record.groupKey &&
        candidate.readAt === undefined,
    )
    if (index === -1) {
      this.records.push({ ...record, count: record.count ?? 1 })
      return
    }
    const existing = this.records[index]!
    // Re-inserted at the end so it lists as the newest, keeping its id.
    this.records.splice(index, 1)
    this.records.push({
      ...record,
      id: existing.id,
      count: (existing.count ?? 1) + (record.count ?? 1),
    })
  }
}

function isPrunable(record: InAppNotification, options: InAppPruneOptions): boolean {
  if (record.readAt !== undefined) return options.readBefore !== undefined && record.readAt < options.readBefore
  return options.unreadBefore !== undefined && record.at < options.unreadBefore
}

export interface InAppMessage {
  title: string
  body?: string
  data?: unknown
  /**
   * Collapse repeats into one inbox row while it is unread ("3 new comments on
   * Contract 12"). Needs a store with `upsertGroup`; on a store without it the
   * notification is appended as its own row, carrying the key.
   */
  groupKey?: string
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
    const record: InAppNotification = {
      id: randomUUID(),
      recipientId: recipient.id,
      notification: info.notification,
      title: inApp.title,
      body: inApp.body,
      data: inApp.data,
      at: Date.now(),
      ...(inApp.groupKey !== undefined ? { groupKey: inApp.groupKey } : {}),
    }
    if (inApp.groupKey !== undefined && this.store.upsertGroup) {
      await this.store.upsertGroup({ ...record, groupKey: inApp.groupKey })
      return
    }
    await this.store.append(record)
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

// ---------------------------------------------------------------- sms / whatsapp

/**
 * Provider-agnostic SMS/WhatsApp transport. Implement it over Twilio, Vonage,
 * MessageBird, AppyPay… — the framework never depends on a provider SDK, the
 * same way payment drivers stay outside the core.
 */
export interface SmsSender {
  send(message: { to: string; from?: string; body: string }): Promise<void>
}

export interface SmsMessage {
  body: string
  /** Override the channel's default sender id for this one message. */
  from?: string
}

export class RecipientPhoneMissingError extends BasaltError {
  constructor(recipientId: string, channel: string) {
    super(
      'NOTIFICATION_PHONE_MISSING',
      `Recipient "${recipientId}" has no address — cannot deliver on the ${channel} channel.`,
    )
  }
}

export interface SmsChannelOptions {
  /** Channel name. Default 'sms'; use 'whatsapp' for the WhatsApp variant. */
  name?: string
  /** Default sender id (phone number / WhatsApp business number). */
  from?: string
  /** How to read the recipient's address. Default: `recipient.phone`. */
  toAddress?: (recipient: Notifiable) => string | undefined
}

/**
 * Delivers notifications over an {@link SmsSender}. Works for both SMS and
 * WhatsApp — the only difference is the channel name and how the address is
 * read, both configurable. Honours per-recipient opt-out via
 * `channelPreferences` (e.g. `{ sms: false }`), like every channel.
 */
export class SmsChannel implements NotificationChannel {
  readonly name: string
  private readonly from: string | undefined
  private readonly toAddress: (recipient: Notifiable) => string | undefined

  constructor(
    private readonly sender: SmsSender,
    options: SmsChannelOptions = {},
  ) {
    this.name = options.name ?? 'sms'
    this.from = options.from
    this.toAddress = options.toAddress ?? ((recipient) => recipient.phone)
  }

  async send(recipient: Notifiable, message: unknown, _info: { notification: string }): Promise<void> {
    const to = this.toAddress(recipient)
    if (!to) throw new RecipientPhoneMissingError(recipient.id, this.name)
    const sms = message as SmsMessage
    const from = sms.from ?? this.from
    await this.sender.send({ to, body: sms.body, ...(from ? { from } : {}) })
  }
}

/**
 * WhatsApp is the SMS channel named 'whatsapp'; addresses default to
 * `recipient.whatsapp ?? recipient.phone`. Point your {@link SmsSender} at the
 * provider's WhatsApp endpoint (e.g. Twilio's `whatsapp:` numbers).
 */
export function whatsappChannel(sender: SmsSender, options: SmsChannelOptions = {}): SmsChannel {
  return new SmsChannel(sender, {
    name: 'whatsapp',
    toAddress: (recipient) => (recipient['whatsapp'] as string | undefined) ?? recipient.phone,
    ...options,
  })
}
