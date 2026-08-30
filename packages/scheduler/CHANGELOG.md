# @basaltkit/scheduler

## 1.3.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/queue@1.4.1

## 1.3.0

### Minor Changes

- cc4786e: **Multi-replica scheduling: `.onOneServer()` + `ScheduleLock` (Q-4), and cron expressions are validated (Q-8 pin).** On a horizontally-scaled deployment every replica ran every scheduled entry — N× duplicate execution of billing/reconciliation jobs, with `withoutOverlapping()` guarding only its own process. Entries can now be marked `.onOneServer()`: at each tick exactly one replica acquires a per-entry, per-minute key through the new `ScheduleLock` contract (`acquire(key, ttlMs)` — any atomic set-if-absent store; a 5-line Redis `SET NX PX` example is in the docs) and runs the task; the others skip and count `skippedByLock`. There is deliberately no release — the key covers the tick window, so a fast first run cannot be followed by a late replica re-running the same minute. Using `.onOneServer()` without a configured `lock` fails loud at boot (running silently on every replica is the failure mode this prevents); `runNow()`/`schedule:run` bypass the lock on purpose. Additionally, `parseCron`/`.cron()` now validate field syntax and ranges at definition time — `MON`, `61 * * * *`, `*/0`, reversed ranges and other unsupported forms throw `CronParseError` instead of producing NaN comparisons and a job that silently never fires. (Behavior change: expressions that previously parsed but could never fire are now rejected at boot.)

### Patch Changes

- Updated dependencies [cc4786e]
  - @basaltkit/queue@1.3.1

## 1.2.0

### Minor Changes

- 56c835c: Add the `schedule:run` CLI command and `Scheduler.runNow`.

  - **`schedule:run <name>`** runs a scheduled task on demand, ignoring its cron; **`schedule:run --due`** runs everything due at this instant (a manual tick). Registered by `schedulerPlugin` into the CLI command bucket, executed against the live `Scheduler` (so overlap guards and `onFailure` handlers still apply).
  - New `Scheduler.runNow(name)` (returns false for an unknown entry) and `Scheduler.names()`.

  Completes the `basalt schedule list|run` surface from the RFC.

## 1.1.0

### Minor Changes

- 56c835c: Add the `schedule:run` CLI command and `Scheduler.runNow`.

  - **`schedule:run <name>`** runs a scheduled task on demand, ignoring its cron; **`schedule:run --due`** runs everything due at this instant (a manual tick). Registered by `schedulerPlugin` into the CLI command bucket, executed against the live `Scheduler` (so overlap guards and `onFailure` handlers still apply).
  - New `Scheduler.runNow(name)` (returns false for an unknown entry) and `Scheduler.names()`.

  Completes the `basalt schedule list|run` surface from the RFC.

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

- @basaltkit/core@0.24.0
- @basaltkit/queue@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/queue@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/queue@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/queue@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/queue@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/queue@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/queue@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/queue@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/queue@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/queue@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/queue@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/queue@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/queue@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/queue@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/queue@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/queue@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/queue@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/queue@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/queue@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [f155979]
- Updated dependencies [f2e8298]
  - @basaltkit/queue@0.6.0
  - @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1
- @basaltkit/queue@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/queue@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0
- @basaltkit/queue@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0
  - @basaltkit/queue@0.3.0

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
  - @basaltkit/core@0.1.0
  - @basaltkit/queue@0.1.0
