import { MachizeError, type HookBus } from '@machize/core'
import type { NotificationChannel } from './channels.js'
import {
  validateNotificationData,
  type Notifiable,
  type NotificationDefinition,
} from './definition.js'

export class UnknownChannelError extends MachizeError {
  constructor(channel: string, notification: string) {
    super(
      'NOTIFICATION_UNKNOWN_CHANNEL',
      `Notification "${notification}" targets channel "${channel}", but no such channel driver is registered.`,
    )
  }
}

export class MissingRendererError extends MachizeError {
  constructor(channel: string, notification: string) {
    super(
      'NOTIFICATION_MISSING_RENDERER',
      `Notification "${notification}" targets channel "${channel}" but defines no via.${channel} renderer.`,
    )
  }
}

/** A rendered, ready-to-send unit — what travels through the queue. */
export interface Delivery {
  notification: string
  channel: string
  recipient: Notifiable
  message: unknown
}

export interface DeliveryReport {
  sent: { channel: string }[]
  failed: { channel: string; error: unknown }[]
  /** Channels skipped by recipient preference. */
  skipped: string[]
}

export interface NotifierOptions {
  channels: NotificationChannel[]
  hooks?: HookBus
}

export class Notifier {
  private readonly channels = new Map<string, NotificationChannel>()
  private readonly hooks: HookBus | undefined
  private enqueue: ((delivery: Delivery) => Promise<void>) | undefined

  constructor(options: NotifierOptions) {
    for (const channel of options.channels) this.channels.set(channel.name, channel)
    this.hooks = options.hooks
  }

  /**
   * Routes deliveries through a dispatcher (typically a @machize/queue job
   * whose handler calls notifier.deliver) instead of sending inline.
   */
  useQueue(dispatch: (delivery: Delivery) => Promise<void>): this {
    this.enqueue = dispatch
    return this
  }

  /**
   * Renders and sends (or enqueues) a notification on every resolved
   * channel. Channel failures are isolated — one failing channel never
   * blocks the others; the report tells what happened.
   */
  async notify<T>(
    recipient: Notifiable,
    definition: NotificationDefinition<T>,
    ...rest: T extends void ? [] : [T]
  ): Promise<DeliveryReport> {
    const data = validateNotificationData(definition, rest[0])
    const requested =
      typeof definition.channels === 'function'
        ? definition.channels(recipient, data)
        : definition.channels

    const report: DeliveryReport = { sent: [], failed: [], skipped: [] }
    for (const channelName of requested) {
      if (recipient.channelPreferences?.[channelName] === false) {
        report.skipped.push(channelName)
        continue
      }
      if (!this.channels.has(channelName)) {
        throw new UnknownChannelError(channelName, definition.name)
      }
      const render = definition.via[channelName]
      if (!render) throw new MissingRendererError(channelName, definition.name)

      const delivery: Delivery = {
        notification: definition.name,
        channel: channelName,
        recipient,
        message: render(data, recipient),
      }
      try {
        if (this.enqueue) await this.enqueue(delivery)
        else await this.deliver(delivery)
        report.sent.push({ channel: channelName })
      } catch (error) {
        report.failed.push({ channel: channelName, error })
        await this.hooks?.emit('notification:failed', {
          notification: definition.name,
          channel: channelName,
          recipientId: recipient.id,
          error,
        })
      }
    }
    return report
  }

  async notifyMany<T>(
    recipients: Notifiable[],
    definition: NotificationDefinition<T>,
    ...rest: T extends void ? [] : [T]
  ): Promise<DeliveryReport[]> {
    const reports: DeliveryReport[] = []
    for (const recipient of recipients) {
      reports.push(await this.notify(recipient, definition, ...rest))
    }
    return reports
  }

  /**
   * Sends a rendered delivery through its channel driver — what a queue
   * worker calls. Throws on failure so the queue can retry.
   */
  async deliver(delivery: Delivery): Promise<void> {
    const channel = this.channels.get(delivery.channel)
    if (!channel) throw new UnknownChannelError(delivery.channel, delivery.notification)
    await channel.send(delivery.recipient, delivery.message, {
      notification: delivery.notification,
    })
    await this.hooks?.emit('notification:sent', {
      notification: delivery.notification,
      channel: delivery.channel,
      recipientId: delivery.recipient.id,
    })
  }
}
