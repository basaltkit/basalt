import type { InAppNotification, InAppStore } from '@basaltkit/notifications'
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
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaNotificationsClient {
  inAppNotification: {
    findMany(a: any): Promise<PInApp[]>
    create(a: any): Promise<PInApp>
    updateMany(a: any): Promise<{ count: number }>
    count(a: any): Promise<number>
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
})

/** The `InAppNotification` columns the store writes as strings. */
export type InAppNotificationColumn = 'id' | 'recipientId' | 'notification' | 'title' | 'body' | 'data'

export type NotificationsColumnLimits = ColumnLimits<{ InAppNotification: InAppNotificationColumn }>

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
