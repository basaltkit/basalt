---
'@basaltkit/dashboard': minor
---

Analytics: `mrrMovement(previous, current, plans)` decomposes the change in MRR
between two subscription snapshots into the standard SaaS bridge — new,
reactivation, expansion, contraction and churned — with the invariant
`new + reactivation + expansion − contraction − churned === net`. Yearly prices
are normalized to monthly; trials and custom-priced plans contribute 0.
`growth(previous, current)` and `change(a, b)` give period-over-period deltas and
ratios for the headline metrics. All pure and browser-safe (types-only import of
`@basaltkit/subscriptions`).
