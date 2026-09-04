import { createToken } from '@basaltkit/core'
import type { InAppStore, NotificationChannel } from './channels.js'
import type { Notifier } from './notifier.js'
import type { NotificationPreferences } from './preferences.js'
import type { Digest } from './digest.js'

/**
 * The container tokens, on their own.
 *
 * Separated so `routes.ts` can reach `IN_APP` without importing the barrel —
 * the barrel re-exports the routes, and that closed a cycle: the route module
 * loaded before `IN_APP` was initialised and the whole package failed to
 * import.
 */
export const NOTIFIER = createToken<Notifier>('notifier')
export const IN_APP = createToken<InAppStore>('notifications:inApp')
export const PREFERENCES = createToken<NotificationPreferences>('notifications:preferences')
export const DIGEST = createToken<Digest>('notifications:digest')
export type { NotificationChannel }
