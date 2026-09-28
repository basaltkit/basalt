import { randomUUID } from 'node:crypto'
import { matchesEvent, type WebhookEndpoint, type WebhookStore } from '@basaltkit/webhooks'

/**
 * Prisma-backed implementation of the `@basaltkit/webhooks` `WebhookStore` (the
 * outbound endpoint subscriptions) for production databases (PostgreSQL, MySQL,
 * …). Bring your generated `PrismaClient` whose schema includes the
 * `WebhookEndpoint` model (see the bundled `prisma/schema.prisma`); the store
 * only touches that delegate. The production counterpart to
 * `@basaltkit/webhooks-sqlite`.
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
    create(a: any): Promise<PWebhookEndpoint>
    updateMany(a: any): Promise<{ count: number }>
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

/**
 * The endpoint id is held by a different scope (another tenant, or a global
 * endpoint when adding a tenant one, or vice versa) — including an id that
 * differs only in letter case on a case-insensitive database collation.
 */
export class WebhookEndpointIdInUseError extends Error {
  readonly code = 'WEBHOOK_ENDPOINT_ID_IN_USE'
  readonly status = 409
  constructor(id: string) {
    super(`@basaltkit/webhooks-prisma: endpoint id "${id}" is already in use by another scope.`)
    this.name = 'WebhookEndpointIdInUseError'
  }
}

export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly client: PrismaWebhooksClient) {}

  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> {
    // Narrow in SQL to active endpoints for this tenant (or tenant-agnostic ones);
    // the event-pattern match (`*`, `prefix.*`, exact) is applied in JS.
    // Fail-closed: without a (non-empty string) tenant only tenant-agnostic
    // endpoints match — a missing/null tenant never widens to every tenant's.
    const and: unknown[] = [{ OR: [{ active: null }, { active: true }] }]
    const scope = typeof tenantId === 'string' && tenantId !== '' ? tenantId : undefined
    if (scope !== undefined) and.push({ OR: [{ tenantId: null }, { tenantId: scope }] })
    else and.push({ tenantId: null })
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
    // Re-adding an id replaces the endpoint — but only within its own scope
    // (tenant, or global). The write is keyed by (id, tenantId), never by id
    // alone: under MySQL's case-insensitive collation 'ABC' matches 'abc', and
    // an upsert by id let one tenant rewrite another's url and secret. An
    // id held by another scope makes the insert hit the primary key instead.
    const scope = { id, tenantId: data.tenantId }
    for (let attempt = 0; attempt < 2; attempt++) {
      const { count } = await this.client.webhookEndpoint.updateMany({ where: scope, data })
      if (count > 0) return record
      try {
        await this.client.webhookEndpoint.create({ data: { id, ...data } })
        return record
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error
        // A concurrent add of the same id in the same scope won the insert:
        // the next update finds it. Any other owner keeps it, and we refuse.
      }
    }
    throw new WebhookEndpointIdInUseError(id)
  }

  async remove(id: string, tenantId?: string): Promise<void> {
    await this.client.webhookEndpoint.deleteMany({
      where: tenantId === undefined ? { id } : { id, tenantId },
    })
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
// this package needs (the alternative is a cryptic "reading 'updateMany' of undefined").
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
  ensureModel(client, 'webhookEndpoint', '@basaltkit/webhooks-prisma')
  return { store: new PrismaWebhookStore(client) }
}
