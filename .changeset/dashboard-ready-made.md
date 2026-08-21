---
"@basaltkit/dashboard": minor
---

Add the ready-made dashboard model: `buildOverview` and `standardDashboard`.

- **`buildOverview(input)`** assembles a full Overview view-model from one snapshot — billing metrics + optional churn (`activeAtStart`) + optional queue health — into `kpis` (each with a semantic `tone`: `positive`/`warning`/`critical`), plus `byPlan`, `byStatus`, `queue`, and `topEvents` breakdowns. Browser-safe (types-only subscriptions import).
- **`standardDashboard(options)`** assembles the conventional layout — Overview → resources → Queues → Audit — with labels and icon hints, over the existing section builders.

A shell renders the model directly; the `apps/admin-demo` reference app now renders every section kind (metrics/resource/queue/audit) from it.
