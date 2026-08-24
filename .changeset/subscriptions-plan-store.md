---
'@basaltkit/subscriptions': minor
---

Add a persistable plan catalog. Plans are consumed as a synchronous `Plans`
object, so the durable source of truth lives in a `PlanStore` and is loaded once
at boot: `const plans = await loadPlans(store)` → `subscriptionsPlugin({ plans })`.
Includes `MemoryPlanStore` (seed it from a `definePlans` object) and
`plansToStored(plans)` to seed a store. Back the `PlanStore` with your database
to manage plans in the DB (edit + restart to apply).
