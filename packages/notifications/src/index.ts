import { createToken, definePlugin } from '@basaltkit/core'
import { MAILER } from '@basaltkit/mailer'
import {
  InAppChannel,
  MailChannel,
  MemoryInAppStore,
  type InAppStore,
  type NotificationChannel,
} from './channels.js'
import { Notifier } from './notifier.js'
import { NotificationPreferences, MemoryPreferenceStore, type PreferenceStore } from './preferences.js'
import { Digest, MemoryDigestStore, type DigestStore } from './digest.js'

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
  SmsChannel,
  whatsappChannel,
  RecipientPhoneMissingError,
  type SmsSender,
  type SmsMessage,
  type SmsChannelOptions,
} from './channels.js'
export {
  Notifier,
  UnknownChannelError,
  MissingRendererError,
  type Delivery,
  type DeliveryReport,
  type NotifierOptions,
} from './notifier.js'
export {
  NotificationPreferences,
  MemoryPreferenceStore,
  type PreferenceStore,
  type NotificationPreference,
} from './preferences.js'
export {
  Digest,
  MemoryDigestStore,
  type DigestStore,
  type DigestItem,
  type DigestBatch,
  type DigestOptions,
} from './digest.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
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
export const PREFERENCES = createToken<NotificationPreferences>('notifications:preferences')
export const DIGEST = createToken<Digest>('notifications:digest')

export interface NotificationsPluginOptions {
  /** Extra channel drivers (sms, push, whatsapp, custom). */
  channels?: NotificationChannel[]
  /** In-app store. Default: memory. Pass false to disable the inApp channel. */
  inApp?: InAppStore | false
  /** Persistable per-user opt-outs. Provide a store (or `true` for in-memory) to enable the PREFERENCES token. */
  preferences?: PreferenceStore | true
  /** Digest batching. Provide a store (or `true` for in-memory) to enable the DIGEST token. */
  digest?: DigestStore | true
}

export function notificationsPlugin(options: NotificationsPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:notifications',
    register({ container, hooks }) {
      const inAppStore = options.inApp === false ? undefined : (options.inApp ?? new MemoryInAppStore())
      if (inAppStore) {
        container.singleton(IN_APP, () => inAppStore)
      }

      const preferences = options.preferences
        ? new NotificationPreferences(options.preferences === true ? new MemoryPreferenceStore() : options.preferences)
        : undefined
      if (preferences) container.singleton(PREFERENCES, () => preferences)

      if (options.digest) {
        const digest = new Digest({ store: options.digest === true ? new MemoryDigestStore() : options.digest })
        container.singleton(DIGEST, () => digest)
      }

      container.singleton(NOTIFIER, () => {
        const channels: NotificationChannel[] = [...(options.channels ?? [])]
        if (inAppStore) channels.push(new InAppChannel(inAppStore))
        // Bridge the mail channel automatically when the mailer is present.
        if (container.has(MAILER)) channels.push(new MailChannel(container.get(MAILER)))
        return new Notifier({ channels, hooks, ...(preferences ? { preferences } : {}) })
      })
    },
  })
}
