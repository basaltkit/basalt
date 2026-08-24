---
'@basaltkit/subscriptions': minor
---

Add metered-billing depth: tiered pricing (`TieredPrice` with `graduated` or
`volume` mode) via `tieredCost(price, units)`, and `meteredLine(feature, { units,
price, includedUnits })` to turn recorded usage into an invoice line (subtracting
the plan's free allowance; `null` when nothing is billable). Complements the flat
`overageLine`. Pure domain.
