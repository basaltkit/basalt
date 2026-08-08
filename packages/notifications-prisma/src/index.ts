import type { InAppNotification, InAppStore } from '@machize/notifications'

/**
 * Prisma-backed implementation of the `@machize/notifications` `InAppStore` for
 * production databases (PostgreSQL, MySQL, …). Bring your generated
 * `PrismaClient` with the `InAppNotification` model (see the bundled
 * `prisma/schema.prisma`). The production counterpart to
 * `@machize/notifications-sqlite`.
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

export class PrismaInAppStore implements InAppStore {
  constructor(private readonly client: PrismaNotificationsClient) {}

  async append(record: InAppNotification): Promise<void> {
    await this.client.inAppNotification.create({
      data: {
        id: record.id,
        recipientId: record.recipientId,
        notification: record.notification,
        title: record.title,
        body: record.body ?? null,
        data: record.data === undefined ? null : JSON.stringify(record.data),
        readAt: record.readAt !== undefined ? at(record.readAt) : null,
        at: at(record.at),
      },
    })
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
 * const n = prismaInAppStore(prisma)
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
        `schema.prisma (run \`mach prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaInAppStore(client: PrismaNotificationsClient): PrismaNotificationsStores {
  ensureModel(client, 'inAppNotification', '@machize/notifications-prisma')
  return { store: new PrismaInAppStore(client) }
}
