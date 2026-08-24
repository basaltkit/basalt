# @basaltkit/dashboard

## 1.2.0

### Minor Changes

- 8f8685b: Analytics: `mrrMovement(previous, current, plans)` decomposes the change in MRR
  between two subscription snapshots into the standard SaaS bridge — new,
  reactivation, expansion, contraction and churned — with the invariant
  `new + reactivation + expansion − contraction − churned === net`. Yearly prices
  are normalized to monthly; trials and custom-priced plans contribute 0.
  `growth(previous, current)` and `change(a, b)` give period-over-period deltas and
  ratios for the headline metrics. All pure and browser-safe (types-only import of
  `@basaltkit/subscriptions`).

## 1.1.0

### Minor Changes

- 19ba769: Add the ready-made dashboard model: `buildOverview` and `standardDashboard`.

  - **`buildOverview(input)`** assembles a full Overview view-model from one snapshot — billing metrics + optional churn (`activeAtStart`) + optional queue health — into `kpis` (each with a semantic `tone`: `positive`/`warning`/`critical`), plus `byPlan`, `byStatus`, `queue`, and `topEvents` breakdowns. Browser-safe (types-only subscriptions import).
  - **`standardDashboard(options)`** assembles the conventional layout — Overview → resources → Queues → Audit — with labels and icon hints, over the existing section builders.

  A shell renders the model directly; the `apps/admin-demo` reference app now renders every section kind (metrics/resource/queue/audit) from it.

### Patch Changes

- Updated dependencies [3125a96]
  - @basaltkit/subscriptions@2.3.0

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/admin@0.24.0
- @basaltkit/subscriptions@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/admin@0.23.0
- @basaltkit/subscriptions@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/admin@0.22.0
- @basaltkit/subscriptions@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/admin@0.21.0
- @basaltkit/subscriptions@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/admin@0.20.0
- @basaltkit/subscriptions@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/admin@0.19.0
- @basaltkit/subscriptions@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/admin@0.18.0
- @basaltkit/subscriptions@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/admin@0.17.0
- @basaltkit/subscriptions@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/admin@0.16.0
- @basaltkit/subscriptions@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/admin@0.15.0
- @basaltkit/subscriptions@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/admin@0.14.0
- @basaltkit/subscriptions@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/admin@0.13.0
- @basaltkit/subscriptions@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/admin@0.12.0
- @basaltkit/subscriptions@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/admin@0.11.0
- @basaltkit/subscriptions@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/admin@0.10.0
- @basaltkit/subscriptions@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/admin@0.9.0
- @basaltkit/subscriptions@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/admin@0.8.1
- @basaltkit/subscriptions@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/admin@0.8.0
- @basaltkit/subscriptions@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/admin@0.7.0
- @basaltkit/subscriptions@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/admin@0.6.0
- @basaltkit/subscriptions@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/subscriptions@0.5.1
- @basaltkit/admin@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [ec514e5]
  - @basaltkit/subscriptions@0.5.0
  - @basaltkit/admin@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/subscriptions@0.4.0
- @basaltkit/admin@0.4.0

## 0.3.0

### Patch Changes

- d0c1436: Make @basaltkit/dashboard browser-safe. computeBillingMetrics no longer imports
  @basaltkit/subscriptions at runtime (which transitively pulled @basaltkit/fastify
  and @basaltkit/core's top-level AsyncLocalStorage) — the subscriptions imports are
  now type-only and planPrice is inlined. Public API unchanged; the package now
  bundles cleanly into a browser admin.
  - @basaltkit/subscriptions@0.3.0
  - @basaltkit/admin@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/admin@0.1.0
  - @basaltkit/subscriptions@0.1.0
