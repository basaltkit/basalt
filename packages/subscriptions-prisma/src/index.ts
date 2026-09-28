import { assertUsageAmount } from '@basaltkit/subscriptions'
import {
  assertColumnLengths,
  type ColumnLimits,
  MYSQL_MEDIUMTEXT,
  MYSQL_TEXT,
  MYSQL_VARCHAR_DEFAULT as V,
  resolveColumnLimits,
} from './column-limits.js'

export { ColumnLengthError, type ColumnLimit, type ColumnLimits } from './column-limits.js'

const PKG = '@basaltkit/subscriptions-prisma'

/** The string columns each model's store writes. */
export type SubscriptionsColumnLimits = ColumnLimits<{
  Subscription: 'billableId' | 'plan' | 'period' | 'status' | 'gatewayRef' | 'pendingPlan' | 'pendingPeriod'
  UsageCounter: 'billableId' | 'feature' | 'periodKey'
  WebhookEvent: 'id'
  Payment: 'id' | 'status' | 'billableId' | 'reference' | 'raw'
  RecurringSubscription: 'billableId' | 'plan' | 'interval' | 'status' | 'pendingPaymentId' | 'customer'
}>

/**
 * The capacities of the bundled `schema.mysql.prisma` — what `columnLimits:
 * 'mysql'` selects, for `prismaSubscriptionsStores` and `prismaPaymentStores`.
 * Spread it to override one column after widening it.
 */
export const subscriptionsMysqlColumnLimits: SubscriptionsColumnLimits = {
  Subscription: {
    billableId: V,
    plan: V,
    period: V,
    status: V,
    gatewayRef: V,
    pendingPlan: V,
    pendingPeriod: V,
  },
  UsageCounter: { billableId: V, feature: V, periodKey: V },
  WebhookEvent: { id: V },
  Payment: { id: V, status: V, billableId: V, reference: V, raw: MYSQL_MEDIUMTEXT },
  RecurringSubscription: {
    billableId: V,
    plan: V,
    interval: V,
    status: V,
    pendingPaymentId: V,
    customer: MYSQL_TEXT,
  },
}

export interface PrismaSubscriptionsStoreOptions {
  /**
   * Refuse (throw `ColumnLengthError`) a value longer than its column instead
   * of letting the database truncate it — on MySQL outside strict mode two
   * long webhook event ids cut to the same prefix make the second look
   * already processed, and a cut `raw` is no longer valid JSON. `'mysql'`
   * uses the limits of the bundled `schema.mysql.prisma`; pass an object for a
   * schema of your own. Default: unchecked (PostgreSQL and SQLite store any
   * length).
   */
  columnLimits?: 'mysql' | SubscriptionsColumnLimits
}

const limitsOf = (options: PrismaSubscriptionsStoreOptions): SubscriptionsColumnLimits | undefined =>
  resolveColumnLimits(PKG, options.columnLimits, subscriptionsMysqlColumnLimits)
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
  pendingPlan?: string | null
  pendingPeriod?: string | null
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
  if (r.pendingPlan != null) rec.pendingPlan = r.pendingPlan
  if (r.pendingPeriod != null) rec.pendingPeriod = r.pendingPeriod as BillingPeriod
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
  // Always written (null clears): the pending-plan intent must not survive
  // its own promotion (see @basaltkit/subscriptions' escalation guard).
  pendingPlan: record.pendingPlan ?? null,
  pendingPeriod: record.pendingPeriod ?? null,
})

export class PrismaSubscriptionStore implements SubscriptionStore {
  private readonly limits: SubscriptionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaSubscriptionsClient,
    options: PrismaSubscriptionsStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async get(billableId: string): Promise<SubscriptionRecord | null> {
    const r = await this.client.subscription.findUnique({ where: { billableId } })
    return r ? toSubscription(r) : null
  }

  async save(record: SubscriptionRecord): Promise<void> {
    const data = subscriptionData(record)
    assertColumnLengths(PKG, this.limits, 'Subscription', { billableId: record.billableId, ...data })
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
  private readonly limits: SubscriptionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaSubscriptionsClient,
    options: PrismaSubscriptionsStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async markProcessed(id: string): Promise<boolean> {
    // A cut id would collide with another event's prefix and report it as
    // already processed — the second event silently dropped.
    assertColumnLengths(PKG, this.limits, 'WebhookEvent', { id })
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
  private readonly limits: SubscriptionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaSubscriptionsClient,
    options: PrismaSubscriptionsStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async get(billableId: string, feature: string, periodKey: string): Promise<number> {
    const r = await this.client.usageCounter.findUnique({ where: usageWhere(billableId, feature, periodKey) })
    return r?.value ?? 0
  }

  async increment(billableId: string, feature: string, periodKey: string, amount: number): Promise<number> {
    // Positive integers only (a negative amount refunds quota, NaN poisons the counter).
    assertUsageAmount(amount)
    assertColumnLengths(PKG, this.limits, 'UsageCounter', { billableId, feature, periodKey })
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
    assertUsageAmount(amount)
    assertColumnLengths(PKG, this.limits, 'UsageCounter', { billableId, feature, periodKey })
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

export function prismaSubscriptionsStores(
  client: PrismaSubscriptionsClient,
  options: PrismaSubscriptionsStoreOptions = {},
): PrismaSubscriptionsStores {
  ensureModel(client, 'subscription', PKG)
  return {
    store: new PrismaSubscriptionStore(client, options),
    usage: new PrismaUsageStore(client, options),
    webhooks: new PrismaWebhookStore(client, options),
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
  private readonly limits: SubscriptionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaPaymentsClient,
    options: PrismaSubscriptionsStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

  async create(payment: NewPayment): Promise<void> {
    const row = {
      id: payment.id,
      status: 'pending',
      amount: toBig(payment.amount),
      billableId: payment.billableId ?? null,
      reference: payment.reference ?? null,
      raw: payment.raw !== undefined ? JSON.stringify(payment.raw) : null,
    }
    assertColumnLengths(PKG, this.limits, 'Payment', row)
    // Atomic idempotent insert: `skipDuplicates` no-ops if the id already exists,
    // so a concurrent create doesn't throw or clobber.
    await this.client.payment.createMany({ data: [row], skipDuplicates: true })
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
    assertColumnLengths(PKG, this.limits, 'Payment', create)
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
  private readonly limits: SubscriptionsColumnLimits | undefined

  constructor(
    private readonly client: PrismaPaymentsClient,
    options: PrismaSubscriptionsStoreOptions = {},
  ) {
    this.limits = limitsOf(options)
  }

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
    assertColumnLengths(PKG, this.limits, 'RecurringSubscription', { billableId: sub.billableId, ...data })
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
export function prismaPaymentStores(
  client: PrismaPaymentsClient,
  options: PrismaSubscriptionsStoreOptions = {},
): PrismaPaymentStores {
  ensureModel(client, 'payment', PKG)
  ensureModel(client, 'recurringSubscription', PKG)
  return {
    payments: new PrismaPaymentStore(client, options),
    recurring: new PrismaRecurringStore(client, options),
  }
}
