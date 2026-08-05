import { createToken, definePlugin } from '@machize/core'
import { MAILER } from '@machize/mailer'
import {
  InAppChannel,
  MailChannel,
  MemoryInAppStore,
  type InAppStore,
  type NotificationChannel,
} from './channels.js'
import { Notifier } from './notifier.js'

export {
  defineNotification,
  NotificationValidationError,
  type Notifiable,
  type NotificationDefinition,
  type NotificationSchema,
} from './definition.js'
export {
  channel,
  InAppChannel,
  MailChannel,
  MemoryInAppStore,
  RecipientEmailMissingError,
  type NotificationChannel,
  type InAppStore,
  type InAppNotification,
  type InAppMessage,
  type MailChannelMessage,
} from './channels.js'
export {
  Notifier,
  UnknownChannelError,
  MissingRendererError,
  type Delivery,
  type DeliveryReport,
  type NotifierOptions,
} from './notifier.js'

declare module '@machize/core' {
  interface MachizeHooks {
    'notification:sent': { notification: string; channel: string; recipientId: string }
    'notification:failed': {
      notification: string
      channel: string
      recipientId: string
      error: unknown
    }
  }
}

export const NOTIFIER = createToken<Notifier>('notifier')
export const IN_APP = createToken<InAppStore>('notifications:inApp')

export interface NotificationsPluginOptions {
  /** Extra channel drivers (sms, push, whatsapp, custom). */
  channels?: NotificationChannel[]
  /** In-app store. Default: memory. Pass false to disable the inApp channel. */
  inApp?: InAppStore | false
}

export function notificationsPlugin(options: NotificationsPluginOptions = {}) {
  return definePlugin({
    name: 'machize:notifications',
    register({ container, hooks }) {
      const inAppStore = options.inApp === false ? undefined : (options.inApp ?? new MemoryInAppStore())
      if (inAppStore) {
        container.singleton(IN_APP, () => inAppStore)
      }

      container.singleton(NOTIFIER, () => {
        const channels: NotificationChannel[] = [...(options.channels ?? [])]
        if (inAppStore) channels.push(new InAppChannel(inAppStore))
        // Bridge the mail channel automatically when the mailer is present.
        if (container.has(MAILER)) channels.push(new MailChannel(container.get(MAILER)))
        return new Notifier({ channels, hooks })
      })
    },
  })
}
