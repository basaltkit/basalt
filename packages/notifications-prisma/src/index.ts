import type {
  InAppNotification,
  InAppPruneOptions,
  InAppStore,
  NotificationPreference,
  PreferenceStore,
} from '@basaltkit/notifications'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_MEDIUMTEXT,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/notifications-prisma'

/**
 * Prisma-backed implementation of the `@basaltkit/notifications` `InAppStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `InAppNotification` model (see the bundled
 * `prisma/schema.prisma`). The production counterpart to
 * `@basaltkit/notifications-sqlite`.
 */

interface PInApp {
  id: string
  recipientId: string
  notification: string
  title: string
  body: string | null
  data: string | null
  readAt: Date | null
  at: Date
  /** Absent on a client generated before the grouping columns were added. */
  groupKey?: string | null
  count?: number | null
}

interface PPreference {
  userId: string
  notification: string
  channel: string
  enabled: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaNotificationsClient {
  inAppNotification: {
    findMany(a: any): Promise<PInApp[]>
    create(a: any): Promise<PInApp>
    updateMany(a: any): Promise<{ count: number }>
    count(a: any): Promise<number>
    /** Used by `prune()` only. Every generated Prisma client has it. */
    deleteMany?(a: any): Promise<{ count: number }>
  }
}

/** The delegate {@link PrismaPreferenceStore} needs — the `NotificationPreference` model. */
export interface PrismaNotificationPreferencesClient {
  notificationPreference: {
    upsert(a: any): Promise<PPreference>
    findMany(a: any): Promise<PPreference[]>
    deleteMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const at = (n: number): Date => new Date(n)

const toNotification = (r: PInApp): InAppNotification => ({
  id: r.id,
  recipientId: r.recipientId,
  notification: r.notification,
  title: r.title,
  at: r.at.getTime(),
  ...(r.body !== null ? { body: r.body } : {}),
  ...(r.data !== null ? { data: JSON.parse(r.data) as unknown } : {}),
  ...(r.readAt !== null ? { readAt: r.readAt.getTime() } : {}),
  ...(r.groupKey != null ? { groupKey: r.groupKey } : {}),
  ...(r.count != null ? { count: r.count } : {}),
})

/** The `InAppNotification` columns the store writes as strings. */
export type InAppNotificationColumn = 'id' | 'recipientId' | 'notification' | 'title' | 'body' | 'data' | 'groupKey'

/** The `NotificationPreference` columns the preference store writes as strings. */
export type NotificationPreferenceColumn = 'userId' | 'notification' | 'channel'

export type NotificationsColumnLimits = ColumnLimits<{
  InAppNotification: InAppNotificationColumn
  NotificationPreference: NotificationPreferenceColumn
}>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects. Spread it to override one column after widening it.
 */
export const notificationsMysqlColumnLimits: NotificationsColumnLimits = {
  InAppNotification: {
    id: V,
    recipientId: V,
    notification: V,
    title: MYSQL_TEXT,
    body: MYSQL_TEXT,
    data: MYSQL_MEDIUMTEXT,
    groupKey: V,
  },
  NotificationPreference: {
    userId: V,
    notification: V,
    channel: V,
  },
}

export interface PrismaInAppStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode a cut
   * `data` is no longer valid JSON and the notification cannot be read back.
   * `'mysql'` uses the limits of the bundled `schema.mysql.prisma`; pass an
   * object for a schema of your own. Default: unchecked (PostgreSQL and SQLite
   * store any length).
   */
  columnLimits?: 'mysql' | NotificationsColumnLimits
}

export class PrismaInAppStore implements InAppStore {
  private readonly limits: NotificationsColumnLimits | undefined

  constructor(
    private readonly client: PrismaNotificationsClient,
    options: PrismaInAppStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, notificationsMysqlColumnLimits)
  }

  async append(record: InAppNotification): Promise<void> {
    const data = {
      id: record.id,
      recipientId: record.recipientId,
      notification: record.notification,
      title: record.title,
      body: record.body ?? null,
      data: record.data === undefined ? null : JSON.stringify(record.data),
      readAt: record.readAt !== undefined ? at(record.readAt) : null,
      at: at(record.at),
      // Written only when used, so a schema without the grouping columns
      // keeps working for every notification that does not group.
      ...(record.groupKey !== undefined ? { groupKey: record.groupKey, count: record.count ?? 1 } : {}),
      ...(record.groupKey === undefined && record.count !== undefined ? { count: record.count } : {}),
    }
    assertColumnLengths(PKG, this.limits, 'InAppNotification', data)
    await this.client.inAppNotification.create({ data })
  }

  async list(
    recipientId: string,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): Promise<InAppNotification[]> {
    const where: Record<string, unknown> = { recipientId }
    if (options.unreadOnly) where.readAt = null
    const args: Record<string, unknown> = {
      where,
      orderBy: [{ at: 'desc' }, { id: 'desc' }], // newest first, deterministic ties
    }
    if (options.limit !== undefined) args.take = options.limit
    const rows = await this.client.inAppNotification.findMany(args)
    return rows.map(toNotification)
  }

  async markRead(recipientId: string, id: string): Promise<boolean> {
    // Only an existing, still-unread notification is marked — idempotent, and the
    // count reports whether it actually changed anything.
    const { count } = await this.client.inAppNotification.updateMany({
      where: { id, recipientId, readAt: null },
      data: { readAt: new Date() },
    })
    return count > 0
  }

  async unreadCount(recipientId: string): Promise<number> {
    return this.client.inAppNotification.count({ where: { recipientId, readAt: null } })
  }

  async markAllRead(recipientId: string): Promise<number> {
    const { count } = await this.client.inAppNotification.updateMany({
      where: { recipientId, readAt: null },
      data: { readAt: new Date() },
    })
    return count
  }

  async prune(options: InAppPruneOptions): Promise<number> {
    const delegate = this.client.inAppNotification
    if (!delegate.deleteMany) throw new Error(`${PKG}: prune() needs the inAppNotification.deleteMany delegate.`)
    let removed = 0
    if (options.readBefore !== undefined) {
      removed += (await delegate.deleteMany({ where: { readAt: { lt: at(options.readBefore) } } })).count
    }
    if (options.unreadBefore !== undefined) {
      removed += (await delegate.deleteMany({ where: { readAt: null, at: { lt: at(options.unreadBefore) } } })).count
    }
    return removed
  }

  /**
   * Bumps the recipient's unread row of the group in one `UPDATE … SET count =
   * count + n`, or creates it when there is none. Two notifications of a group
   * arriving at the same instant may both miss and create two rows — later
   * ones then bump both; the inbox shows the group twice, nothing is lost.
   */
  async upsertGroup(record: InAppNotification & { groupKey: string }): Promise<void> {
    const data = {
      notification: record.notification,
      title: record.title,
      body: record.body ?? null,
      data: record.data === undefined ? null : JSON.stringify(record.data),
      at: at(record.at),
    }
    assertColumnLengths(PKG, this.limits, 'InAppNotification', { ...data, groupKey: record.groupKey })
    const { count } = await this.client.inAppNotification.updateMany({
      where: { recipientId: record.recipientId, groupKey: record.groupKey, readAt: null },
      data: { ...data, count: { increment: record.count ?? 1 } },
    })
    if (count === 0) await this.append({ ...record, count: record.count ?? 1 })
  }
}

/**
 * Durable {@link PreferenceStore} for `notificationsPlugin({ preferences })`,
 * over the `NotificationPreference` model of the bundled schema.
 */
export class PrismaPreferenceStore implements PreferenceStore {
  private readonly limits: NotificationsColumnLimits | undefined

  constructor(
    private readonly client: PrismaNotificationPreferencesClient,
    options: PrismaInAppStoreOptions = {},
  ) {
    this.limits = resolveColumnLimits(PKG, options.columnLimits, notificationsMysqlColumnLimits)
  }

  async set(preference: NotificationPreference): Promise<void> {
    const key = { userId: preference.userId, notification: preference.notification, channel: preference.channel }
    assertColumnLengths(PKG, this.limits, 'NotificationPreference', key)
    await this.client.notificationPreference.upsert({
      where: { userId_notification_channel: key },
      create: { ...key, enabled: preference.enabled },
      update: { enabled: preference.enabled },
    })
  }

  async list(userId: string): Promise<NotificationPreference[]> {
    const rows = await this.client.notificationPreference.findMany({ where: { userId } })
    return rows.map((r) => ({ userId: r.userId, notification: r.notification, channel: r.channel, enabled: r.enabled }))
  }

  async remove(userId: string, notification: string, channel: string): Promise<void> {
    await this.client.notificationPreference.deleteMany({ where: { userId, notification, channel } })
  }
}

export interface PrismaNotificationsStores {
  store: PrismaInAppStore
}

/**
 * Wire the in-app store to your Prisma client, named to drop straight into
 * `notificationsPlugin`:
 *
 * ```ts
 * const n = prismaInAppStore(prisma) // on MySQL: prismaInAppStore(prisma, { columnLimits: 'mysql' })
 * notificationsPlugin({ inApp: n.store, mailer })
 * ```
 */
// Fail fast with an actionable message when the Prisma client lacks the models
// this package needs (the alternative is a cryptic "reading 'create' of undefined").
function ensureModel(client: unknown, delegate: string, pkg: string): void {
  let value: unknown
  try {
    value = (client as Record<string, unknown>)[delegate]
  } catch {
    return // lazy/proxy client (e.g. database-per-tenant) — validated at first use
  }
  if (value == null) {
    throw new Error(
      `${pkg}: the Prisma client has no \`${delegate}\` model. Add its models to your ` +
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaInAppStore(
  client: PrismaNotificationsClient,
  options: PrismaInAppStoreOptions = {},
): PrismaNotificationsStores {
  ensureModel(client, 'inAppNotification', PKG)
  return { store: new PrismaInAppStore(client, options) }
}

/**
 * The durable preference store, named for `notificationsPlugin`:
 *
 * ```ts
 * notificationsPlugin({ inApp: prismaInAppStore(prisma).store, preferences: prismaPreferenceStore(prisma) })
 * ```
 */
export function prismaPreferenceStore(
  client: PrismaNotificationPreferencesClient,
  options: PrismaInAppStoreOptions = {},
): PrismaPreferenceStore {
  ensureModel(client, 'notificationPreference', PKG)
  return new PrismaPreferenceStore(client, options)
}
