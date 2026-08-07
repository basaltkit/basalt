# @machize/billing-ui

## 0.21.0

### Patch Changes

- @machize/core@0.21.0
- @machize/fastify@0.21.0
- @machize/subscriptions@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0
- @machize/fastify@0.20.0
- @machize/subscriptions@0.20.0

## 0.19.0

### Minor Changes

- 3ae1c5a: New package: `@machize/billing-ui` — a subscription page for `@machize/subscriptions`.

  `billingUiRoutes({ plans, path?, apiBase?, title?, headers? })` serves a self-contained, dependency-free HTML page at `GET /billing/ui` plus its data at `GET /billing/info` (`{ subscription, plans }` for the current tenant). The page shows the active plan with its status and trial, lists the plans as cards, and wires Subscribe/Switch to `POST /billing/checkout` (hosted Checkout) and Manage-billing to `POST /billing/portal` (Customer Portal) — both from `@machize/subscriptions`' `billingRoutes()`. It fetches same-origin with optional injected headers for header-based tenancy. `billingPageHtml(...)` returns the HTML for custom serving. Tested (the page and the end-to-end HTTP flow: info before/after subscribing, checkout and portal via the fake gateway).

### Patch Changes

- @machize/core@0.19.0
- @machize/fastify@0.19.0
- @machize/subscriptions@0.19.0
