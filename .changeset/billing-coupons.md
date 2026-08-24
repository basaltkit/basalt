---
'@basaltkit/subscriptions': minor
---

Add coupons & discounts (billing depth). A `Coupon` is `percentOff` (0–100) or a
fixed `amountOff` (minor units + currency), with optional `maxRedemptions` and
`redeemBy` expiry. `couponDiscount()` computes the discount on a subtotal;
`Invoices.draft({ coupon })` applies it (on top of any explicit discount, clamped
to the subtotal) and records `couponCode`. A `Coupons` registry (with
`CouponStore`/`MemoryCouponStore`) defines, quotes (validating redeemability) and
redeems codes. Pure domain — no HTTP, no gateway.
