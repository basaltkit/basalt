---
"@machize/dashboard": patch
---

Make @machize/dashboard browser-safe. computeBillingMetrics no longer imports
@machize/subscriptions at runtime (which transitively pulled @machize/fastify
and @machize/core's top-level AsyncLocalStorage) — the subscriptions imports are
now type-only and planPrice is inlined. Public API unchanged; the package now
bundles cleanly into a browser admin.
