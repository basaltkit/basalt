---
"@basaltkit/subscriptions-prisma": minor
"@basaltkit/subscriptions-sqlite": minor
---

Persist the `pendingPlan` / `pendingPeriod` fields backing `@basaltkit/subscriptions`' checkout-escalation guard.

- **subscriptions-prisma:** the reference `schema.prisma` gains two optional columns (`pendingPlan String?`, `pendingPeriod String?`). **Action required:** re-sync your app schema (`basalt prisma:sync`) and run a migration; the store now always writes these columns, so an un-migrated database will fail loudly on save rather than silently mis-handling a plan change.
- **subscriptions-sqlite:** columns are added automatically (`ALTER TABLE … ADD COLUMN` on open, tolerated when they already exist) — no action needed.
