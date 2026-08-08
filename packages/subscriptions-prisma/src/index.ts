import type {
  BillingPeriod,
  SubscriptionRecord,
  SubscriptionStatus,
  SubscriptionStore,
  UsageConsumeResult,
  UsageStore,
  WebhookStore,
} from '@machize/subscriptions'

/**
 * Prisma-backed implementations of the three `@machize/subscriptions` stores —
 * subscriptions, usage metering and webhook idempotency — for production
 * databases (PostgreSQL, MySQL, …). Bring your generated `PrismaClient` whose
 * schema includes the `Subscription`, `UsageCounter` and `WebhookEvent` models
 * (see the bundled `prisma/schema.prisma`).
 *
 * The metered `consume()` is **atomic**: a conditional `updateMany` increments
 * only while the guarded `value <= limit - amount` holds, and the database's
 * row lock serializes concurrent callers — so a quota is never overshot. The
 * production counterpart to `@machize/subscriptions-sqlite`.
 */

interface PSubscription {
  billableId: string
  plan: string
  period: string
  status: string
  trialEndsAt: Date | null
  cancelAtPeriodEnd: boolean | null
  canceledAt: Date | null
  gatewayRef: string | null
}
interface PUsage {
  billableId: string
  feature: string
  periodKey: string
  value: number
}

/**
 * The minimal Prisma delegate surface the stores call — a real `PrismaClient`
 * with these models is assignable, so pass it directly. Method arguments are
 * typed `any` on purpose (Prisma's generated method generics can't be reproduced
 * by a hand-written interface); return types stay precise.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PrismaSubscriptionsClient {
  subscription: {
    findUnique(a: any): Promise<PSubscription | null>
    findMany(a: any): Promise<PSubscription[]>
    upsert(a: any): Promise<PSubscription>
  }
  usageCounter: {
    findUnique(a: any): Promise<PUsage | null>
    createMany(a: any): Promise<{ count: number }>
    updateMany(a: any): Promise<{ count: number }>
  }
  webhookEvent: {
    createMany(a: any): Promise<{ count: number }>
    deleteMany(a: any): Promise<{ count: number }>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const ms = (d: Date): number => d.getTime()
const at = (n: number): Date => new Date(n)

// --- subscriptions ----------------------------------------------------------

const toSubscription = (r: PSubscription): SubscriptionRecord => {
  const rec: SubscriptionRecord = {
    billableId: r.billableId,
    plan: r.plan,
    period: r.period as BillingPeriod,
    status: r.status as SubscriptionStatus,
  }
  if (r.trialEndsAt !== null) rec.trialEndsAt = ms(r.trialEndsAt)
  if (r.cancelAtPeriodEnd !== null) rec.cancelAtPeriodEnd = r.cancelAtPeriodEnd
  if (r.canceledAt !== null) rec.canceledAt = ms(r.canceledAt)
  if (r.gatewayRef !== null) rec.gatewayRef = r.gatewayRef
  return rec
}

const subscriptionData = (record: SubscriptionRecord): Record<string, unknown> => ({
  plan: record.plan,
  period: record.period,
  status: record.status,
  trialEndsAt: record.trialEndsAt !== undefined ? at(record.trialEndsAt) : null,
  cancelAtPeriodEnd: record.cancelAtPeriodEnd ?? null,
  canceledAt: record.canceledAt !== undefined ? at(record.canceledAt) : null,
  gatewayRef: record.gatewayRef ?? null,
})

export class PrismaSubscriptionStore implements SubscriptionStore {
  constructor(private readonly client: PrismaSubscriptionsClient) {}

  async get(billableId: string): Promise<SubscriptionRecord | null> {
    const r = await this.client.subscription.findUnique({ where: { billableId } })
    return r ? toSubscription(r) : null
  }

  async save(record: SubscriptionRecord): Promise<void> {
    const data = subscriptionData(record)
    await this.client.subscription.upsert({
      where: { billableId: record.billableId },
      create: { billableId: record.billableId, ...data },
      update: data,
    })
  }

  async all(): Promise<SubscriptionRecord[]> {
    const rows = await this.client.subscription.findMany({ orderBy: { billableId: 'asc' } })
    return rows.map(toSubscription)
  }
}

// --- webhook idempotency ----------------------------------------------------

export class PrismaWebhookStore implements WebhookStore {
  constructor(private readonly client: PrismaSubscriptionsClient) {}

  async markProcessed(id: string): Promise<boolean> {
    // Atomic claim: insert the id, skipping (not throwing on) a duplicate.
    // count === 1 means we just claimed it; 0 means it was already processed.
    const { count } = await this.client.webhookEvent.createMany({ data: [{ id }], skipDuplicates: true })
    return count === 1
  }

  async release(id: string): Promise<void> {
    await this.client.webhookEvent.deleteMany({ where: { id } })
  }
}

// --- usage metering ---------------------------------------------------------

const usageWhere = (billableId: string, feature: string, periodKey: string): object => ({
  billableId_feature_periodKey: { billableId, feature, periodKey },
})

export class PrismaUsageStore implements UsageStore {
  constructor(private readonly client: PrismaSubscriptionsClient) {}

  async get(billableId: string, feature: string, periodKey: string): Promise<number> {
    const r = await this.client.usageCounter.findUnique({ where: usageWhere(billableId, feature, periodKey) })
    return r?.value ?? 0
  }

  async increment(billableId: string, feature: string, periodKey: string, amount: number): Promise<number> {
    // Seed with a concurrency-safe createMany (skipDuplicates) rather than an
    // upsert — two concurrent upserts of the same new row both miss and race to
    // INSERT, failing with P2002 on a real database.
    await this.client.usageCounter.createMany({
      data: [{ billableId, feature, periodKey, value: 0 }],
      skipDuplicates: true,
    })
    await this.client.usageCounter.updateMany({
      where: { billableId, feature, periodKey },
      data: { value: { increment: amount } },
    })
    const row = await this.client.usageCounter.findUnique({ where: usageWhere(billableId, feature, periodKey) })
    return row?.value ?? 0
  }

  async consume(
    billableId: string,
    feature: string,
    periodKey: string,
    amount: number,
    limit: number,
  ): Promise<UsageConsumeResult> {
    // Ensure the counter row exists (idempotent and concurrency-safe via
    // skipDuplicates — a plain upsert races to INSERT and fails with P2002 under
    // concurrent first-touch), then increment only while the guard holds. The
    // conditional updateMany is a single locked UPDATE, so concurrent callers
    // re-check the guard against the committed value and can never overshoot.
    await this.client.usageCounter.createMany({
      data: [{ billableId, feature, periodKey, value: 0 }],
      skipDuplicates: true,
    })
    const { count } = await this.client.usageCounter.updateMany({
      where: { billableId, feature, periodKey, value: { lte: limit - amount } },
      data: { value: { increment: amount } },
    })
    const row = await this.client.usageCounter.findUnique({ where: usageWhere(billableId, feature, periodKey) })
    return { applied: count === 1, used: row?.value ?? 0 }
  }
}

// --- convenience ------------------------------------------------------------

export interface PrismaSubscriptionsStores {
  store: PrismaSubscriptionStore
  usage: PrismaUsageStore
  webhooks: PrismaWebhookStore
}

/**
 * Wire all three subscription stores to your Prisma client, named to drop
 * straight into `subscriptionsPlugin`:
 *
 * ```ts
 * const s = prismaSubscriptionsStores(prisma)
 * subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })
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

export function prismaSubscriptionsStores(client: PrismaSubscriptionsClient): PrismaSubscriptionsStores {
  ensureModel(client, 'subscription', '@machize/subscriptions-prisma')
  return {
    store: new PrismaSubscriptionStore(client),
    usage: new PrismaUsageStore(client),
    webhooks: new PrismaWebhookStore(client),
  }
}
