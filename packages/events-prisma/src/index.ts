import { randomUUID } from 'node:crypto'
import type {
  OutboxClaimOptions,
  OutboxEntry,
  OutboxMarkFailedOptions,
  OutboxPendingFilter,
  OutboxStore,
} from '@basaltkit/events'

/**
 * Prisma-backed implementation of the `@basaltkit/events` `OutboxStore` (the
 * transactional outbox) for production databases (PostgreSQL, MySQL, …). Bring
 * your generated `PrismaClient` whose schema includes the `OutboxEntry` model
 * (see the bundled `prisma/schema.prisma`); the store only touches that
 * delegate.
 *
 * Keeping the outbox in the SAME database as your business writes is what makes
 * the pattern work — enqueue the event in the same transaction as the state
 * change (`outbox.enqueue(event, payload, { tx })` inside `$transaction`), and
 * delivery becomes at-least-once and crash-safe. With `{ claim: true }` several
 * relays (replicas) can share the table without double-dispatching. The production
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
  // Present when the schema has the claim columns (`{ claim: true }`).
  lockedUntil?: Date | null
  lockedBy?: string | null
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

export interface PrismaOutboxStoreOptions {
  /**
   * Claim pending rows before dispatching (`lockedUntil` / `lockedBy` columns),
   * so several relays — one per replica — never deliver the same entry at once,
   * and a failed entry's retry backoff holds across replicas. Requires the two
   * columns from the reference schema (`basalt prisma:sync`, then migrate).
   * Default false, so an existing schema without them keeps working; turn it on
   * whenever more than one process runs the relay.
   */
  claim?: boolean
}

/** The transaction client the store writes through — Prisma's interactive-transaction `tx`. */
export interface PrismaOutboxTx {
  outboxEntry: Pick<PrismaEventsClient['outboxEntry'], 'upsert'>
}

// A row is claimable when never claimed or when its lease expired.
const claimable = (now: number) => ({ OR: [{ lockedUntil: null }, { lockedUntil: { lte: at(now) } }] })

export class PrismaOutboxStore implements OutboxStore {
  /**
   * Present only with `{ claim: true }` — the relay checks for it, so a store
   * whose schema lacks the lock columns is never asked to write them.
   */
  readonly claim?: (ids: string[], options: OutboxClaimOptions) => Promise<string[]>
  private readonly claiming: boolean

  constructor(
    private readonly client: PrismaEventsClient,
    options: PrismaOutboxStoreOptions = {},
  ) {
    this.claiming = options.claim === true
    if (this.claiming) this.claim = (ids, claimOptions) => this.claimRows(ids, claimOptions)
  }

  /**
   * Writes the entry. Pass `{ tx }` — the client Prisma hands to
   * `$transaction(async (tx) => …)` — to write it in the same transaction as
   * your state change: a rollback removes both.
   */
  async enqueue(
    input: {
      id?: string
      event: string
      payload: unknown
      tenantId?: string
      createdAt: number
    },
    options: { tx?: PrismaOutboxTx } = {},
  ): Promise<OutboxEntry> {
    const id = input.id ?? randomUUID()
    const payload = input.payload === undefined ? null : JSON.stringify(input.payload)
    // upsert mirrors MemoryOutboxStore: re-enqueuing the same id replaces the
    // entry (attempts reset to 0, publish/error/claim cleared).
    const base = {
      event: input.event,
      payload,
      tenantId: input.tenantId ?? null,
      createdAt: at(input.createdAt),
    }
    const release = this.claiming ? { lockedUntil: null, lockedBy: null } : {}
    const delegate = options.tx ? options.tx.outboxEntry : this.client.outboxEntry
    await delegate.upsert({
      where: { id },
      create: { id, ...base, attempts: 0 },
      update: { ...base, attempts: 0, publishedAt: null, lastError: null, ...release },
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

  async pending(limit: number, maxAttempts: number, filter: OutboxPendingFilter = {}): Promise<OutboxEntry[]> {
    // Tenant exclusion (relay fairness): SQL `NOT IN` never matches a NULL
    // tenantId, so tenant-less rows are kept or dropped explicitly.
    const excluded = filter.excludeTenantIds ?? []
    const where: Record<string, unknown> = { publishedAt: null, attempts: { lt: maxAttempts } }
    if (excluded.length > 0) {
      if (filter.excludeGlobal) where.tenantId = { notIn: excluded }
      else where.OR = [{ tenantId: null }, { tenantId: { notIn: excluded } }]
    } else if (filter.excludeGlobal) {
      where.tenantId = { not: null }
    }
    // Claiming relays: hide rows another relay holds (or that sit in a stored
    // retry backoff). ANDed so it composes with the tenant `OR` above.
    if (this.claiming && filter.now !== undefined) where.AND = [claimable(filter.now)]
    const rows = await this.client.outboxEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    })
    return rows.map(toEntry)
  }

  /**
   * Atomic claim without raw SQL: ONE conditional `updateMany` stamps this
   * relay's token on the rows that are still unpublished and unclaimed (or whose
   * lease expired); a concurrent relay's identical UPDATE re-checks the
   * condition once the row lock is released (Postgres/MySQL), so each row is
   * won by exactly one token. A second query reads back which rows were won.
   * Portable across Prisma providers and — being model queries, not
   * `$queryRaw` — compatible with the tenancy extension's raw-query guard.
   */
  private async claimRows(ids: string[], options: OutboxClaimOptions): Promise<string[]> {
    if (ids.length === 0) return []
    await this.client.outboxEntry.updateMany({
      where: { id: { in: ids }, publishedAt: null, ...claimable(options.now) },
      data: { lockedUntil: at(options.until), lockedBy: options.token },
    })
    const won = await this.client.outboxEntry.findMany({
      where: { id: { in: ids }, lockedBy: options.token },
      select: { id: true },
    })
    return won.map((row) => row.id)
  }

  async markPublished(id: string, at_: number): Promise<void> {
    // updateMany (not update) so a missing id is a no-op, matching MemoryOutboxStore.
    const release = this.claiming ? { lockedUntil: null, lockedBy: null } : {}
    await this.client.outboxEntry.updateMany({ where: { id }, data: { publishedAt: at(at_), ...release } })
  }

  async markFailed(id: string, error: string, options: OutboxMarkFailedOptions = {}): Promise<void> {
    // Claiming: release the row, or hold it until the retry time so no replica
    // retries it before the backoff elapses.
    const release = this.claiming
      ? { lockedUntil: options.retryAt !== undefined ? at(options.retryAt) : null, lockedBy: null }
      : {}
    await this.client.outboxEntry.updateMany({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error, ...release },
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
 * const outbox = prismaOutboxStore(prisma, { claim: true }) // claim: safe with N replicas
 * outboxPlugin({ store: outbox.store, dispatch, captureEvents: ['order.*'], intervalMs: 1000 })
 * ```
 */
export function prismaOutboxStore(
  client: PrismaEventsClient,
  options: PrismaOutboxStoreOptions = {},
): PrismaEventsStores {
  ensureModel(client, 'outboxEntry', '@basaltkit/events-prisma')
  return { store: new PrismaOutboxStore(client, options) }
}
