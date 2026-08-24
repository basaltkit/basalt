import { describe, expect, it } from 'vitest'
import {
  Coupons,
  MemoryCouponStore,
  CouponInvalidError,
  CouponNotRedeemableError,
  CouponNotFoundError,
  assertValidCoupon,
  couponRedeemable,
  couponDiscount,
  Invoices,
  MemoryInvoiceStore,
} from '../src/index.js'

describe('couponDiscount', () => {
  it('applies percent off, rounded and clamped', () => {
    expect(couponDiscount({ code: 'A', percentOff: 20 }, 2900, 'USD')).toBe(580)
    expect(couponDiscount({ code: 'A', percentOff: 33 }, 1000, 'USD')).toBe(330)
    expect(couponDiscount({ code: 'A', percentOff: 100 }, 500, 'USD')).toBe(500)
  })
  it('applies fixed amount off, clamped to the subtotal', () => {
    expect(couponDiscount({ code: 'B', amountOff: 500, currency: 'USD' }, 2900, 'USD')).toBe(500)
    expect(couponDiscount({ code: 'B', amountOff: 5000, currency: 'USD' }, 2900, 'USD')).toBe(2900)
  })
  it('gives no discount for a currency mismatch or non-positive subtotal', () => {
    expect(couponDiscount({ code: 'B', amountOff: 500, currency: 'EUR' }, 2900, 'USD')).toBe(0)
    expect(couponDiscount({ code: 'A', percentOff: 20 }, 0, 'USD')).toBe(0)
  })
})

describe('assertValidCoupon', () => {
  it('requires exactly one of percentOff / amountOff', () => {
    expect(() => assertValidCoupon({ code: 'X' })).toThrow(CouponInvalidError)
    expect(() => assertValidCoupon({ code: 'X', percentOff: 10, amountOff: 100, currency: 'USD' })).toThrow(CouponInvalidError)
  })
  it('bounds percentOff and requires currency for amountOff', () => {
    expect(() => assertValidCoupon({ code: 'X', percentOff: 120 })).toThrow(/between 0 and 100/)
    expect(() => assertValidCoupon({ code: 'X', amountOff: 500 })).toThrow(/requires a currency/)
    expect(() => assertValidCoupon({ code: 'X', percentOff: 20 })).not.toThrow()
  })
})

describe('couponRedeemable', () => {
  it('honours expiry and the redemption cap', () => {
    const c = { code: 'C', percentOff: 10, redeemBy: 1000, maxRedemptions: 2 }
    expect(couponRedeemable(c, { now: 500 })).toBe(true)
    expect(couponRedeemable(c, { now: 1500 })).toBe(false) // expired
    expect(couponRedeemable(c, { now: 500, redemptions: 2 })).toBe(false) // capped
  })
})

describe('Coupons registry', () => {
  const make = () => {
    let t = 1000
    return { coupons: new Coupons({ store: new MemoryCouponStore(), now: () => t }), setNow: (n: number) => (t = n) }
  }

  it('defines, quotes and redeems a coupon', async () => {
    const { coupons } = make()
    await coupons.define({ code: 'LAUNCH20', percentOff: 20 })
    const { discount } = await coupons.quote('LAUNCH20', 2900, 'USD')
    expect(discount).toBe(580)
    const after = await coupons.redeem('LAUNCH20')
    expect(after.redemptions).toBe(1)
  })

  it('rejects unknown, expired, capped and wrong-currency coupons', async () => {
    const { coupons, setNow } = make()
    await expect(coupons.quote('NOPE', 100, 'USD')).rejects.toBeInstanceOf(CouponNotFoundError)

    await coupons.define({ code: 'GONE', percentOff: 50, redeemBy: 900 })
    await expect(coupons.quote('GONE', 100, 'USD')).rejects.toBeInstanceOf(CouponNotRedeemableError)

    await coupons.define({ code: 'ONCE', amountOff: 100, currency: 'USD', maxRedemptions: 1 })
    await coupons.redeem('ONCE')
    await expect(coupons.quote('ONCE', 500, 'USD')).rejects.toBeInstanceOf(CouponNotRedeemableError)

    await coupons.define({ code: 'EURO', amountOff: 100, currency: 'EUR' })
    await expect(coupons.quote('EURO', 500, 'USD')).rejects.toThrow(/only valid for EUR/)
    setNow(1000)
  })

  it('rejects an invalid coupon at define time', async () => {
    const { coupons } = make()
    await expect(coupons.define({ code: 'BAD' })).rejects.toBeInstanceOf(CouponInvalidError)
  })
})

describe('Invoices with a coupon', () => {
  it('applies the coupon discount and records the code', async () => {
    const invoices = new Invoices({ store: new MemoryInvoiceStore(), now: () => 0 })
    const inv = await invoices.draft({
      billableId: 't', currency: 'USD',
      lineItems: [{ description: 'Pro', unitAmount: 2900 }],
      coupon: { code: 'LAUNCH20', percentOff: 20 },
    })
    expect(inv.discount).toBe(580) // 20% of 2900
    expect(inv.total).toBe(2900 - 580)
    expect(inv.couponCode).toBe('LAUNCH20')
  })

  it('adds the coupon on top of an explicit discount, clamped to the subtotal', async () => {
    const invoices = new Invoices({ store: new MemoryInvoiceStore(), now: () => 0 })
    const inv = await invoices.draft({
      billableId: 't', currency: 'USD',
      lineItems: [{ description: 'x', unitAmount: 1000 }],
      discount: 300,
      coupon: { code: 'HALF', percentOff: 90 }, // 900; 300+900=1200 → clamped to 1000
    })
    expect(inv.discount).toBe(1000)
    expect(inv.total).toBe(0)
  })
})
