import type {
  BillingPeriod,
  NewPayment,
  PaymentRecord,
  PaymentRecordStatus,
  PaymentStore,
  RecurringInterval,
  RecurringStatus,
  RecurringStore,
  RecurringSubscription,
  SubscriptionRecord,
  SubscriptionStatus,
  SubscriptionStore,
  UsageConsumeResult,
  UsageStore,
  WebhookStore,
} from '@basaltkit/subscriptions'

/**
 * Prisma-backed implementations of the three `@basaltkit/subscriptions` stores —
 * subscriptions, usage metering and webhook idempotency — for production
 * databases (PostgreSQL, MySQL, …). Bring your generated `PrismaClient` whose
 * schema includes the `Subscription`, `UsageCounter` and `WebhookEvent` models
 * (see the bundled `prisma/schema.prisma`).
 *
 * The metered `consume()` is **atomic**: a conditional `updateMany` increments
 * only while the guarded `value <= limit - amount` holds, and the database's
 * row lock serializes concurrent callers — so a quota is never overshot. The
 * production counterpart to `@basaltkit/subscriptions-sqlite`.
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
        `schema.prisma (run \`basalt prisma:sync\`, or copy from '${pkg}/schema.prisma'), then \`prisma generate\`.`,
    )
  }
}

export function prismaSubscriptionsStores(client: PrismaSubscriptionsClient): PrismaSubscriptionsStores {
  ensureModel(client, 'subscription', '@basaltkit/subscriptions-prisma')
  return {
    store: new PrismaSubscriptionStore(client),
    usage: new PrismaUsageStore(client),
    webhooks: new PrismaWebhookStore(client),
  }
}

// --- payments ledger + recurring --------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
interface PPayment {
  id: string
  status: string
  amount: bigint
  billableId: string | null
  reference: string | null
  raw: string | null
  createdAt: Date
  updatedAt: Date
}
interface PRecurring {
  billableId: string
  plan: string
  amount: bigint
  interval: string
  status: string
  paidThrough: Date | null
  pendingPaymentId: string | null
  customer: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Prisma delegates the payment stores call. A real `PrismaClient` whose schema
 * includes the `Payment` and `RecurringSubscription` models (see the bundled
 * `prisma/schema.prisma`) is assignable. **Money is stored as `BigInt`** (minor
 * units) to avoid the 32-bit `Int` ceiling; the stores convert to/from `number`.
 */
export interface PrismaPaymentsClient {
  payment: {
    findUnique(a: any): Promise<PPayment | null>
    createMany(a: any): Promise<{ count: number }>
    upsert(a: any): Promise<PPayment>
    update(a: any): Promise<PPayment>
  }
  recurringSubscription: {
    findUnique(a: any): Promise<PRecurring | null>
    findMany(a: any): Promise<PRecurring[]>
    upsert(a: any): Promise<PRecurring>
    update(a: any): Promise<PRecurring>
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** True for Prisma's unique-constraint violation (a concurrent create race). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
}

const toBig = (n: number): bigint => BigInt(Math.round(n))

export class PrismaPaymentStore implements PaymentStore {
  constructor(private readonly client: PrismaPaymentsClient) {}

  async create(payment: NewPayment): Promise<void> {
    // Atomic idempotent insert: `skipDuplicates` no-ops if the id already exists,
    // so a concurrent create doesn't throw or clobber.
    await this.client.payment.createMany({
      data: [
        {
          id: payment.id,
          status: 'pending',
          amount: toBig(payment.amount),
          billableId: payment.billableId ?? null,
          reference: payment.reference ?? null,
          raw: payment.raw !== undefined ? JSON.stringify(payment.raw) : null,
        },
      ],
      skipDuplicates: true,
    })
  }

  async setStatus(
    id: string,
    status: PaymentRecordStatus,
    patch: { amount?: number; raw?: unknown } = {},
  ): Promise<void> {
    const update: Record<string, unknown> = { status }
    if (patch.amount != null) update.amount = toBig(patch.amount)
    if (patch.raw !== undefined) update.raw = patch.raw != null ? JSON.stringify(patch.raw) : null
    const create = {
      id,
      status,
      amount: toBig(patch.amount ?? 0),
      raw: patch.raw != null ? JSON.stringify(patch.raw) : null,
    }
    try {
      await this.client.payment.upsert({ where: { id }, create, update })
    } catch (error) {
      // Lost the create race — the row now exists; apply the update instead.
      if (!isUniqueViolation(error)) throw error
      await this.client.payment.update({ where: { id }, data: update })
    }
  }

  async get(id: string): Promise<PaymentRecord | undefined> {
    const p = await this.client.payment.findUnique({ where: { id } })
    if (!p) return undefined
    const rec: PaymentRecord = {
      id: p.id,
      status: p.status as PaymentRecordStatus,
      amount: Number(p.amount),
      createdAt: ms(p.createdAt),
      updatedAt: ms(p.updatedAt),
    }
    if (p.billableId !== null) rec.billableId = p.billableId
    if (p.reference !== null) rec.reference = p.reference
    if (p.raw !== null) rec.raw = JSON.parse(p.raw)
    return rec
  }
}

const toRecurring = (r: PRecurring): RecurringSubscription => {
  const sub: RecurringSubscription = {
    billableId: r.billableId,
    plan: r.plan,
    amount: Number(r.amount),
    interval: r.interval as RecurringInterval,
    status: r.status as RecurringStatus,
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }
  if (r.paidThrough !== null) sub.paidThrough = ms(r.paidThrough)
  if (r.pendingPaymentId !== null) sub.pendingPaymentId = r.pendingPaymentId
  if (r.customer !== null) sub.customer = JSON.parse(r.customer)
  return sub
}

export class PrismaRecurringStore implements RecurringStore {
  constructor(private readonly client: PrismaPaymentsClient) {}

  async save(sub: RecurringSubscription): Promise<void> {
    const data = {
      plan: sub.plan,
      amount: toBig(sub.amount),
      interval: sub.interval,
      status: sub.status,
      paidThrough: sub.paidThrough != null ? at(sub.paidThrough) : null,
      pendingPaymentId: sub.pendingPaymentId ?? null,
      customer: sub.customer ? JSON.stringify(sub.customer) : null,
      updatedAt: at(sub.updatedAt),
    }
    try {
      await this.client.recurringSubscription.upsert({
        where: { billableId: sub.billableId },
        create: { billableId: sub.billableId, createdAt: at(sub.createdAt), ...data },
        update: data,
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      await this.client.recurringSubscription.update({ where: { billableId: sub.billableId }, data })
    }
  }

  async get(billableId: string): Promise<RecurringSubscription | undefined> {
    const r = await this.client.recurringSubscription.findUnique({ where: { billableId } })
    return r ? toRecurring(r) : undefined
  }

  async list(): Promise<RecurringSubscription[]> {
    const rows = await this.client.recurringSubscription.findMany({ orderBy: { billableId: 'asc' } })
    return rows.map(toRecurring)
  }
}

export interface PrismaPaymentStores {
  payments: PrismaPaymentStore
  recurring: PrismaRecurringStore
}

/**
 * Wire the payment ledger + recurring stores to your Prisma client:
 *
 * ```ts
 * const p = prismaPaymentStores(prisma)
 * const ledger = new PaymentLedger({ store: p.payments, webhooks: s.webhooks })
 * const billing = new RecurringReferenceBilling({ gateway, ledger, store: p.recurring })
 * ```
 */
export function prismaPaymentStores(client: PrismaPaymentsClient): PrismaPaymentStores {
  ensureModel(client, 'payment', '@basaltkit/subscriptions-prisma')
  ensureModel(client, 'recurringSubscription', '@basaltkit/subscriptions-prisma')
  return { payments: new PrismaPaymentStore(client), recurring: new PrismaRecurringStore(client) }
}
