import { randomUUID } from 'node:crypto'
import type { OutboxEntry, OutboxStore } from '@basaltkit/events'

/**
 * Prisma-backed implementation of the `@basaltkit/events` `OutboxStore` (the
 * transactional outbox) for production databases (PostgreSQL, MySQL, …). Bring
 * your generated `PrismaClient` whose schema includes the `OutboxEntry` model
 * (see the bundled `prisma/schema.prisma`); the store only touches that
 * delegate.
 *
 * Keeping the outbox in the SAME database as your business writes is what makes
 * the pattern work — enqueue the event in the same transaction as the state
 * change, and delivery becomes at-least-once and crash-safe. The production
 * counterpart to `@basaltkit/events-sqlite`.
 */

// Prisma-return row shape (DateTime → Date; nullable columns → null).
interface POutbox {
  id: string
  event: string
  payload: string | null
  tenantId: string | null
  createdAt: Date
  attempts: number
  publishedAt: Date | null
  lastError: string | null
}

/**
 * The minimal Prisma delegate surface the store calls — a real `PrismaClient`
 * with the `OutboxEntry` model is assignable, so pass it directly. Method
 * arguments are typed `any` on purpose (Prisma's generated method generics can't
 * be reproduced by a hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaEventsClient {
  outboxEntry: {
    upsert(a: any): Promise<POutbox>
    findMany(a: any): Promise<POutbox[]>
    updateMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// The @basaltkit/events contract models time as epoch-ms numbers; Prisma models it
// as DateTime. Convert at the edges.
const ms = (d: Date): number => d.getTime()
const at = (n: number): Date => new Date(n)

const toEntry = (r: POutbox): OutboxEntry => ({
  id: r.id,
  event: r.event,
  payload: r.payload === null ? undefined : (JSON.parse(r.payload) as unknown),
  createdAt: ms(r.createdAt),
  attempts: r.attempts,
  ...(r.tenantId !== null ? { tenantId: r.tenantId } : {}),
  ...(r.publishedAt !== null ? { publishedAt: ms(r.publishedAt) } : {}),
  ...(r.lastError !== null ? { lastError: r.lastError } : {}),
})

export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly client: PrismaEventsClient) {}

  async enqueue(input: {
    id?: string
    event: string
    payload: unknown
    tenantId?: string
    createdAt: number
  }): Promise<OutboxEntry> {
    const id = input.id ?? randomUUID()
    const payload = input.payload === undefined ? null : JSON.stringify(input.payload)
    // upsert mirrors MemoryOutboxStore: re-enqueuing the same id replaces the
    // entry (attempts reset to 0, publish/error cleared).
    const base = {
      event: input.event,
      payload,
      tenantId: input.tenantId ?? null,
      createdAt: at(input.createdAt),
    }
    await this.client.outboxEntry.upsert({
      where: { id },
      create: { id, ...base, attempts: 0 },
      update: { ...base, attempts: 0, publishedAt: null, lastError: null },
    })
    return {
      id,
      event: input.event,
      payload: input.payload,
      createdAt: input.createdAt,
      attempts: 0,
      ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    }
  }

  async pending(limit: number, maxAttempts: number): Promise<OutboxEntry[]> {
    const rows = await this.client.outboxEntry.findMany({
      where: { publishedAt: null, attempts: { lt: maxAttempts } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    })
    return rows.map(toEntry)
  }

  async markPublished(id: string, at_: number): Promise<void> {
    // updateMany (not update) so a missing id is a no-op, matching MemoryOutboxStore.
    await this.client.outboxEntry.updateMany({ where: { id }, data: { publishedAt: at(at_) } })
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.client.outboxEntry.updateMany({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error },
    })
  }

  async all(): Promise<OutboxEntry[]> {
    const rows = await this.client.outboxEntry.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return rows.map(toEntry)
  }
}

export interface PrismaEventsStores {
  store: PrismaOutboxStore
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
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

/**
 * Wire the outbox store to your Prisma client, named to drop straight into
 * `outboxPlugin`:
 *
 * ```ts
 * const outbox = prismaOutboxStore(prisma)
 * outboxPlugin({ store: outbox.store, dispatch, captureEvents: ['order.*'], intervalMs: 1000 })
 * ```
 */
export function prismaOutboxStore(client: PrismaEventsClient): PrismaEventsStores {
  ensureModel(client, 'outboxEntry', '@basaltkit/events-prisma')
  return { store: new PrismaOutboxStore(client) }
}
