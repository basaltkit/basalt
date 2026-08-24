import { BasaltError } from '@basaltkit/core'

/** Structural schema compatible with Zod. */
export interface NotificationSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export class NotificationValidationError extends BasaltError {
  constructor(
    readonly notification: string,
    readonly issues: unknown,
  ) {
    super(
      'NOTIFICATION_INVALID',
      `Invalid data for notification "${notification}": ${JSON.stringify(issues)}`,
    )
  }
}

/** Who receives notifications. Apps map their user/tenant models onto this. */
export interface Notifiable {
  id: string
  email?: string
  /** Phone number (E.164, e.g. +244923...) — used by the sms/whatsapp channels. */
  phone?: string
  /** Per-channel opt-out: `{ sms: false }` silences the sms channel. */
  channelPreferences?: Record<string, boolean>
  [key: string]: unknown
}

export interface NotificationDefinition<T = void> {
  readonly name: string
  readonly schema?: NotificationSchema<T> | undefined
  /** Channels for a delivery — static list or per-recipient function. */
  channels: string[] | ((recipient: Notifiable, data: T) => string[])
  /** Renderers per channel — each returns that channel's message shape. */
  via: Record<string, (data: T, recipient: Notifiable) => unknown>
}

/**
 * export const InvoicePaid = defineNotification({
 *   name: 'invoice.paid',
 *   schema: z.object({ number: z.string() }),
 *   channels: ['mail', 'inApp'],
 *   via: {
 *     mail: ({ number }) => ({ subject: `Invoice ${number} paid`, text: '…' }),
 *     inApp: ({ number }) => ({ title: 'Invoice paid', body: `#${number} confirmed` }),
 *   },
 * })
 */
export function defineNotification<T = void>(
  definition: NotificationDefinition<T>,
): NotificationDefinition<T> {
  return definition
}

export function validateNotificationData<T>(
  definition: NotificationDefinition<T>,
  data: unknown,
): T {
  if (!definition.schema) return data as T
  const result = definition.schema.safeParse(data)
  if (!result.success) {
    const issues =
      (result.error as { issues?: unknown[] } | undefined)?.issues ?? result.error ?? 'unknown'
    throw new NotificationValidationError(definition.name, issues)
  }
  return result.data as T
}
