import { BasaltError } from '@basaltkit/core'
import { assertMinorUnits } from './money.js'

/**
 * Coupons & discounts — the next layer of billing depth on top of `Invoices`.
 * A coupon is either `percentOff` (0–100) or a fixed `amountOff` (minor units),
 * with optional redemption caps and an expiry. `couponDiscount()` turns it into
 * a concrete discount on a subtotal; `Invoices.draft({ coupon })` applies it.
 * Pure domain — no HTTP, no gateway.
 */

/** How long a coupon applies to a subscription's recurring charges. */
export type CouponDuration = 'once' | 'forever' | { repeatingMonths: number }

export interface Coupon {
  /** Human code entered at checkout, e.g. `LAUNCH20`. Unique. */
  code: string
  /** Percent off (0–100). Mutually exclusive with `amountOff`. */
  percentOff?: number
  /** Fixed amount off in minor units. Requires `currency`. Mutually exclusive with `percentOff`. */
  amountOff?: number
  /** Currency of `amountOff` — a discount only applies to invoices in the same currency. */
  currency?: string
  /** Recurring applicability. Default `'once'`. Informational for one-off invoices. */
  duration?: CouponDuration
  /** Stop accepting the coupon after this many redemptions. */
  maxRedemptions?: number
  /** Epoch ms after which the coupon is expired. */
  redeemBy?: number
  metadata?: Record<string, unknown>
}

export class CouponInvalidError extends BasaltError {
  readonly status = 422
  constructor(code: string, reason: string) {
    super('COUPON_INVALID', `Coupon "${code}" is invalid: ${reason}.`)
  }
}

export class CouponNotRedeemableError extends BasaltError {
  readonly status = 422
  constructor(code: string, reason: string) {
    super('COUPON_NOT_REDEEMABLE', `Coupon "${code}" cannot be redeemed: ${reason}.`)
  }
}

export class CouponNotFoundError extends BasaltError {
  readonly status = 404
  constructor(code: string) {
    super('COUPON_NOT_FOUND', `Coupon "${code}" was not found.`)
  }
}

/** Validate a coupon's *shape*. Throws `CouponInvalidError`. */
export function assertValidCoupon(coupon: Coupon): void {
  const hasPercent = coupon.percentOff !== undefined
  const hasAmount = coupon.amountOff !== undefined
  if (hasPercent === hasAmount) {
    throw new CouponInvalidError(coupon.code, 'set exactly one of percentOff or amountOff')
  }
  if (hasPercent && (coupon.percentOff! < 0 || coupon.percentOff! > 100)) {
    throw new CouponInvalidError(coupon.code, 'percentOff must be between 0 and 100')
  }
  if (hasAmount) {
    assertMinorUnits(coupon.amountOff!, 'amountOff')
    if (coupon.amountOff! < 0) throw new CouponInvalidError(coupon.code, 'amountOff must be ≥ 0')
    if (!coupon.currency) throw new CouponInvalidError(coupon.code, 'amountOff requires a currency')
  }
  if (coupon.maxRedemptions !== undefined && coupon.maxRedemptions < 1) {
    throw new CouponInvalidError(coupon.code, 'maxRedemptions must be ≥ 1')
  }
}

/** Is the coupon redeemable right now (not expired, under its redemption cap)? */
export function couponRedeemable(coupon: Coupon, ctx: { now: number; redemptions?: number }): boolean {
  if (coupon.redeemBy !== undefined && ctx.now > coupon.redeemBy) return false
  if (coupon.maxRedemptions !== undefined && (ctx.redemptions ?? 0) >= coupon.maxRedemptions) return false
  return true
}

/**
 * The discount (minor units) a coupon yields on a subtotal, clamped to
 * `[0, subtotal]`. A fixed-amount coupon in a different currency yields 0.
 */
export function couponDiscount(coupon: Coupon, subtotalMinor: number, currency: string): number {
  if (subtotalMinor <= 0) return 0
  if (coupon.percentOff !== undefined) {
    return Math.min(subtotalMinor, Math.round(subtotalMinor * (coupon.percentOff / 100)))
  }
  if (coupon.amountOff !== undefined) {
    if (coupon.currency && coupon.currency !== currency) return 0
    return Math.min(subtotalMinor, Math.max(0, Math.round(coupon.amountOff)))
  }
  return 0
}

export interface CouponRecord extends Coupon {
  redemptions: number
}

export interface CouponStore {
  save(coupon: CouponRecord): Promise<void>
  get(code: string): Promise<CouponRecord | null>
  all(): Promise<CouponRecord[]>
  /** Atomically increment the redemption counter; returns the new count. */
  incrementRedemptions(code: string): Promise<number>
}

/** In-memory store — swap for a durable one in production. */
export class MemoryCouponStore implements CouponStore {
  private readonly records = new Map<string, CouponRecord>()

  async save(coupon: CouponRecord): Promise<void> {
    this.records.set(coupon.code, { ...coupon })
  }
  async get(code: string): Promise<CouponRecord | null> {
    const found = this.records.get(code)
    return found ? { ...found } : null
  }
  async all(): Promise<CouponRecord[]> {
    return [...this.records.values()].map((c) => ({ ...c }))
  }
  async incrementRedemptions(code: string): Promise<number> {
    const record = this.records.get(code)
    if (!record) throw new CouponNotFoundError(code)
    record.redemptions += 1
    return record.redemptions
  }
}

export interface CouponsOptions {
  store?: CouponStore
  now?: () => number
}

/** A registry of coupons: define, look up, quote a discount and redeem. */
export class Coupons {
  private readonly store: CouponStore
  private readonly now: () => number

  constructor(options: CouponsOptions = {}) {
    this.store = options.store ?? new MemoryCouponStore()
    this.now = options.now ?? (() => Date.now())
  }

  /** Validate and persist a coupon. Throws `CouponInvalidError` on a bad shape. */
  async define(coupon: Coupon): Promise<CouponRecord> {
    assertValidCoupon(coupon)
    const record: CouponRecord = { ...coupon, redemptions: 0 }
    await this.store.save(record)
    return record
  }

  async get(code: string): Promise<CouponRecord | null> {
    return this.store.get(code)
  }
  async list(): Promise<CouponRecord[]> {
    return this.store.all()
  }

  /**
   * Compute the discount a coupon code yields on a subtotal, validating that it
   * exists and is redeemable. Throws `CouponNotFoundError` /
   * `CouponNotRedeemableError`. Does **not** consume a redemption — call
   * `redeem()` once the charge succeeds.
   */
  async quote(
    code: string,
    subtotalMinor: number,
    currency: string,
  ): Promise<{ coupon: CouponRecord; discount: number }> {
    const coupon = await this.store.get(code)
    if (!coupon) throw new CouponNotFoundError(code)
    if (!couponRedeemable(coupon, { now: this.now(), redemptions: coupon.redemptions })) {
      throw new CouponNotRedeemableError(code, 'expired or redemption limit reached')
    }
    const discount = couponDiscount(coupon, subtotalMinor, currency)
    if (coupon.amountOff !== undefined && coupon.currency && coupon.currency !== currency) {
      throw new CouponNotRedeemableError(code, `only valid for ${coupon.currency}`)
    }
    return { coupon, discount }
  }

  /** Record a successful redemption (increments the counter). */
  async redeem(code: string): Promise<CouponRecord> {
    await this.store.incrementRedemptions(code)
    const updated = await this.store.get(code)
    if (!updated) throw new CouponNotFoundError(code)
    return updated
  }
}
