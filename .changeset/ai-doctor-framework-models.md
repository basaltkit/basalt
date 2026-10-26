---
'@basaltkit/ai': patch
---

`ai:doctor`: `tenant-scoping-missing` no longer flags the framework's own models. The `-prisma` packages ship `AuthUser`, `AuthSession`, the other `Auth*` tables, `Perm*`, the notifications and subscriptions tables without a `tenantId` by design (identity is central; membership is checked by `tenantMembershipPlugin`), and the rule told apps to add one — a column the stores never read or write. They are matched by model name and `@@map` table, so an app's own `Payment` or `Subscription` is still checked. The schema parser also skips `//` comments, so a `}` inside one no longer ends the model early and hides the fields after it.
