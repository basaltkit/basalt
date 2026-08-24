import {
  validateNotificationData,
  type Notifiable,
  type NotificationDefinition,
} from './definition.js'

/**
 * Digest / batching — instead of sending every notification immediately,
 * `collect()` renders and holds it; a scheduled `flush()` groups each
 * recipient's pending items per channel and sends them as one batch (a daily
 * summary, say). The app decides how to render the combined message.
 */
export interface DigestItem {
  recipientId: string
  channel: string
  notification: string
  message: unknown
  at: number
}

export interface DigestStore {
  add(item: DigestItem): Promise<void>
  pending(): Promise<DigestItem[]>
  clear(recipientId: string, channel: string): Promise<void>
}

export class MemoryDigestStore implements DigestStore {
  private items: DigestItem[] = []
  async add(item: DigestItem): Promise<void> {
    this.items.push({ ...item })
  }
  async pending(): Promise<DigestItem[]> {
    return this.items.map((i) => ({ ...i }))
  }
  async clear(recipientId: string, channel: string): Promise<void> {
    this.items = this.items.filter((i) => !(i.recipientId === recipientId && i.channel === channel))
  }
}

export interface DigestOptions {
  store: DigestStore
  now?: () => number
}

export interface DigestBatch {
  recipientId: string
  channel: string
  items: DigestItem[]
}

export class Digest {
  private readonly store: DigestStore
  private readonly now: () => number

  constructor(options: DigestOptions) {
    this.store = options.store
    this.now = options.now ?? (() => Date.now())
  }

  /** Render a notification and hold it for the recipient's next digest instead of sending now. */
  async collect<T>(
    recipient: Notifiable,
    definition: NotificationDefinition<T>,
    ...rest: T extends void ? [] : [T]
  ): Promise<void> {
    const data = validateNotificationData(definition, rest[0])
    const channels =
      typeof definition.channels === 'function' ? definition.channels(recipient, data) : definition.channels
    for (const channel of channels) {
      const render = definition.via[channel]
      if (!render) continue
      await this.store.add({
        recipientId: recipient.id,
        channel,
        notification: definition.name,
        message: render(data, recipient),
        at: this.now(),
      })
    }
  }

  /** Send each recipient's accumulated items (grouped per channel) via `send`, then clear. Returns batches flushed. */
  async flush(send: (batch: DigestBatch) => Promise<void>): Promise<number> {
    const grouped = new Map<string, DigestItem[]>()
    for (const item of await this.store.pending()) {
      const key = `${item.recipientId}::${item.channel}`
      const list = grouped.get(key) ?? []
      list.push(item)
      grouped.set(key, list)
    }
    let flushed = 0
    for (const [key, items] of grouped) {
      const [recipientId = '', channel = ''] = key.split('::')
      await send({ recipientId, channel, items })
      await this.store.clear(recipientId, channel)
      flushed += 1
    }
    return flushed
  }
}
