# @machize/billing-ui

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@machize/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

### Patch Changes

- @machize/core@0.24.0
- @machize/fastify@0.24.0
- @machize/subscriptions@0.24.0

## 0.23.0

### Patch Changes

- @machize/core@0.23.0
- @machize/fastify@0.23.0
- @machize/subscriptions@0.23.0

## 0.22.0

### Patch Changes

- @machize/core@0.22.0
- @machize/fastify@0.22.0
- @machize/subscriptions@0.22.0

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
