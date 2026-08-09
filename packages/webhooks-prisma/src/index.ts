import { randomUUID } from 'node:crypto'
import { matchesEvent, type WebhookEndpoint, type WebhookStore } from '@machize/webhooks'

/**
 * Prisma-backed implementation of the `@machize/webhooks` `WebhookStore` (the
 * outbound endpoint subscriptions) for production databases (PostgreSQL, MySQL,
 * …). Bring your generated `PrismaClient` whose schema includes the
 * `WebhookEndpoint` model (see the bundled `prisma/schema.prisma`); the store
 * only touches that delegate. The production counterpart to
 * `@machize/webhooks-sqlite`.
 */

// Prisma-return row shape (nullable columns → null; events stored as JSON text).
interface PWebhookEndpoint {
  id: string
  url: string
  events: string
  tenantId: string | null
  secret: string | null
  active: boolean | null
}

/**
 * The minimal Prisma delegate surface the store calls — a real `PrismaClient`
 * with the `WebhookEndpoint` model is assignable, so pass it directly. Method
 * arguments are typed `any` on purpose (Prisma's generated method generics can't
 * be reproduced by a hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaWebhooksClient {
  webhookEndpoint: {
    findMany(a: any): Promise<PWebhookEndpoint[]>
    upsert(a: any): Promise<PWebhookEndpoint>
    deleteMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const toEndpoint = (r: PWebhookEndpoint): WebhookEndpoint => ({
  id: r.id,
  url: r.url,
  events: JSON.parse(r.events) as string[],
  ...(r.tenantId !== null ? { tenantId: r.tenantId } : {}),
  ...(r.secret !== null ? { secret: r.secret } : {}),
  ...(r.active !== null ? { active: r.active } : {}),
})

export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly client: PrismaWebhooksClient) {}

  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> {
    // Narrow in SQL to active endpoints for this tenant (or tenant-agnostic ones);
    // the event-pattern match (`*`, `prefix.*`, exact) is applied in JS.
    const and: unknown[] = [{ OR: [{ active: null }, { active: true }] }]
    if (tenantId !== undefined) and.push({ OR: [{ tenantId: null }, { tenantId }] })
    const rows = await this.client.webhookEndpoint.findMany({ where: { AND: and } })
    return rows.map(toEndpoint).filter((endpoint) => matchesEvent(endpoint.events, event))
  }

  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> {
    const id = endpoint.id ?? randomUUID()
    const record: WebhookEndpoint = { ...endpoint, id }
    const data = {
      url: record.url,
      events: JSON.stringify(record.events),
      tenantId: record.tenantId ?? null,
      secret: record.secret ?? null,
      active: record.active === undefined ? null : record.active,
    }
    // upsert mirrors MemoryWebhookStore: re-adding the same id replaces it.
    await this.client.webhookEndpoint.upsert({ where: { id }, create: { id, ...data }, update: data })
    return record
  }

  async remove(id: string): Promise<void> {
    await this.client.webhookEndpoint.deleteMany({ where: { id } })
  }

  async list(tenantId?: string): Promise<WebhookEndpoint[]> {
    const rows = await this.client.webhookEndpoint.findMany({
      ...(tenantId !== undefined ? { where: { tenantId } } : {}),
      orderBy: { id: 'asc' },
    })
    return rows.map(toEndpoint)
  }
}

export interface PrismaWebhooksStores {
  store: PrismaWebhookStore
}

// Fail fast with an actionable message when the Prisma client lacks the model
// this package needs (the alternative is a cryptic "reading 'upsert' of undefined").
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

/**
 * Wire the webhook store to your Prisma client, named to drop straight into
 * `webhooksPlugin`:
 *
 * ```ts
 * const webhooks = prismaWebhookStore(prisma)
 * webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
 * ```
 */
export function prismaWebhookStore(client: PrismaWebhooksClient): PrismaWebhooksStores {
  ensureModel(client, 'webhookEndpoint', '@machize/webhooks-prisma')
  return { store: new PrismaWebhookStore(client) }
}
