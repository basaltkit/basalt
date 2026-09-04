# @basaltkit/testing

## 2.0.0

### Major Changes

- 5cd162d: Every HTTP adapter is now an optional peer, `@basaltkit/fastify` included.
  
  `@basaltkit/express` and `@basaltkit/hono` were already optional peers — the
  application's copy is used, and there can only be one. `@basaltkit/fastify` was
  a plain dependency, because fastify is the default adapter.
  
  That asymmetry has a cost that surfaces only on a version skew. When this
  package moved its fastify range to `^2` while an application was still on `1.x`,
  pnpm installed **both**, and `createTestApp` resolved a `FASTIFY` token from a
  different copy than the one the app's `fastifyPlugin` had registered — two
  `createToken('fastify')` calls, two object identities, one container that cannot
  match them. What the developer saw was:
  
  ```
  UnknownTokenError: No provider registered for token "fastify".
  Register it with container.singleton()/scoped()/transient() in some plugin.
  ```
  
  Five untouched tests failed and the message named a missing plugin. Neither this
  package nor the version skew appears anywhere in it. It took half an hour to
  find.
  
  A peer cannot duplicate. There is one copy, the application's, and a version
  skew now surfaces at install time as a peer warning instead of at runtime as a
  token that does not exist.
  
  **BREAKING: `app.server` is now `await app.server()`.** The adapter is imported
  on demand — the same way `express` and `hono` already were — so that an
  application booted with no HTTP plugin at all still works and so that nothing
  here reaches for a package the app may not have installed. Resolving a token
  through a dynamic import cannot be synchronous.
  
  ```diff
  - const fastify = app.server
  + const fastify = await app.server()
  ```
  
  A major for a change of this shape, which is the other half of the lesson: the
  release that moved a peer range to a new major should itself have been a major.
  An application declaring `^1.1.3` does not expect a tree with two adapters in
  it.
  
  A test now asserts the package.json shape directly — every adapter a peer, none
  a dependency, and no HTTP framework pulled in either — so the next person to add
  one has to mean it.

## 1.2.0

### Minor Changes

- 30abb78: A tenant can be removed.
  
  `TenantSource` had `find`, `findByDomain`, `list`, `create` and `save`, and
  `Tenancy` had no `destroy`. There was no path out — not even an optional one.
  Two things followed.
  
  In tests, isolation suites reached for raw SQL:
  `$executeRawUnsafe('DROP SCHEMA "tenant_' + id + '" CASCADE')`. It normalises
  string interpolation into an SQL identifier, and the reason it was needed is
  worse than the pattern: without that cleanup, a schema left by a failed run
  makes the next provisioning a no-op, and every assertion below it passes green
  against the previous run's data. The suite stops testing anything and says
  nothing.
  
  In production, a self-serve signup that failed halfway left a PostgreSQL schema
  that nothing in the framework could remove.
  
  ```ts
  tenancyPlugin({ source, resolvers, onProvision, onDeprovision })
  
  await tenancy.destroy('acme')
  await tenancy.destroy('acme', { force: true })
  ```
  
  ```bash
  basalt tenant:destroy acme          # asks first
  basalt tenant:destroy acme --yes    # for scripts
  ```
  
  **The order of operations is the design**, and each step is where it is because
  the alternative loses something:
  
  1. **Mark `deleting`** — a new `TenantStatus`, so the resolver answers 503 and
     stops routing before anything is torn down. Dropping a schema out from under
     live requests produces errors nobody can interpret, from a tenant that looked
     healthy a second earlier.
  2. **Run `onDeprovision` inside the tenant's context**, exactly like
     `onProvision`, so a tenant-scoped client points at the storage being removed.
  3. **Delete the record last.** The record is the only thing naming that storage.
     Delete it first and a failed teardown orphans a schema nobody can find —
     which is the state this method exists to prevent.
  
  If teardown throws, the record survives marked `deleting` and the error
  propagates: the evidence is kept and a retry can finish. `force` removes the
  record anyway, for when the storage is already gone by other means; it is a
  deliberate way to orphan storage, so it is never the default.
  
  A source that cannot delete gets `TenantDeleteUnsupportedError` rather than a
  success it did not perform — a tenant that looks removed and still resolves is
  worse than one that never left. `MemoryTenantSource`, `tenancy-prisma` and
  `tenancy-sqlite` all implement `delete()`; the Prisma and SQLite sources keep
  their existing `remove()` as the older name.
  
  **`@basaltkit/testing` gains `withTenant(tenancy, id, fn)`** — provision, run,
  clean up, *including when the test throws*, which is the case that matters: a
  failing test that leaves its tenant behind makes the next run fail for a
  different reason. It also destroys a leftover of the same id before starting,
  because a previous run may have died between writing the record and creating the
  schema, and a suite should be able to recover on its own.

## 1.1.4

### Patch Changes

- Updated dependencies [d5ca076]
  - @basaltkit/fastify@2.0.0

## 1.1.3

### Patch Changes

- Updated dependencies [48579dd]
  - @basaltkit/mailer@2.0.0

## 1.1.2

### Patch Changes

- Updated dependencies [ffd3565]
  - @basaltkit/queue@2.0.0

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1
  - @basaltkit/fastify@1.8.1
  - @basaltkit/mailer@1.4.1
  - @basaltkit/queue@1.4.1

## 1.1.0

### Minor Changes

- c345eab: `createTestApp` is now adapter-parametrizable: pass `adapter: 'fastify' | 'express' | 'hono'` and the same suite drives requests through any HTTP adapter.
  
  - **Default unchanged:** `'fastify'` keeps the exact previous behavior — in-process `inject()`, `LightMyRequestResponse` responses, no socket, and no adapter resolution unless a request is actually made (mailer/queue-only test apps still boot without any HTTP plugin).
  - **`adapter: 'express'`** listens on an ephemeral `127.0.0.1` port and dispatches via `fetch` (Express has no in-process inject); the socket closes on `shutdown()`. **`adapter: 'hono'`** dispatches in-process via `hono.fetch(new Request(…))`.
  - All drivers return the new neutral `TestResponse` shape (`statusCode`, `headers`, `body`, sync `json()`), which the Fastify inject response already satisfies — existing suites read responses unchanged. Pass the matching adapter plugin (`expressPlugin`/`honoPlugin`) in `plugins` yourself, exactly as with `fastifyPlugin` today.
  - `@basaltkit/express` and `@basaltkit/hono` are **optional peerDependencies**, resolved lazily only when their adapter is requested — a fastify-only install pulls nothing new; a missing peer fails with an actionable error.
  - New exports: `TestAdapterName`, `TestResponse`, `CreateTestAppOptions`. Impersonation (`actingAs`/`asTenant`) works identically on every adapter — it rides the framework-neutral `http:enrichers` bucket.
  - New cross-adapter conformance suite exercises the neutral HTTP contract (routing/validation/guards/enrichers/error mapping) identically on Fastify, Express and Hono.

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
- @basaltkit/fastify@0.24.0
- @basaltkit/mailer@0.24.0
- @basaltkit/queue@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0
- @basaltkit/mailer@0.23.0
- @basaltkit/queue@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0
- @basaltkit/mailer@0.22.0
- @basaltkit/queue@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0
- @basaltkit/mailer@0.21.0
- @basaltkit/queue@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0
- @basaltkit/mailer@0.20.0
- @basaltkit/queue@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0
- @basaltkit/mailer@0.19.0
- @basaltkit/queue@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0
- @basaltkit/mailer@0.18.0
- @basaltkit/queue@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0
- @basaltkit/mailer@0.17.0
- @basaltkit/queue@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0
- @basaltkit/mailer@0.16.0
- @basaltkit/queue@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/fastify@0.15.0
- @basaltkit/mailer@0.15.0
- @basaltkit/queue@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/fastify@0.14.0
- @basaltkit/mailer@0.14.0
- @basaltkit/queue@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/fastify@0.13.0
- @basaltkit/mailer@0.13.0
- @basaltkit/queue@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/fastify@0.12.0
- @basaltkit/mailer@0.12.0
- @basaltkit/queue@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/fastify@0.11.0
- @basaltkit/mailer@0.11.0
- @basaltkit/queue@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/fastify@0.10.0
- @basaltkit/mailer@0.10.0
- @basaltkit/queue@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/fastify@0.9.0
- @basaltkit/mailer@0.9.0
- @basaltkit/queue@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/fastify@0.8.1
- @basaltkit/mailer@0.8.1
- @basaltkit/queue@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/fastify@0.8.0
- @basaltkit/mailer@0.8.0
- @basaltkit/queue@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/fastify@0.7.0
- @basaltkit/mailer@0.7.0
- @basaltkit/queue@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [f155979]
- Updated dependencies [f2e8298]
  - @basaltkit/queue@0.6.0
  - @basaltkit/core@0.6.0
  - @basaltkit/fastify@0.6.0
  - @basaltkit/mailer@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/fastify@0.5.1
- @basaltkit/core@0.5.1
- @basaltkit/mailer@0.5.1
- @basaltkit/queue@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/fastify@0.5.0
- @basaltkit/mailer@0.5.0
- @basaltkit/queue@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @basaltkit/fastify@0.4.0
  - @basaltkit/core@0.4.0
  - @basaltkit/mailer@0.4.0
  - @basaltkit/queue@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [4846bc1]
- Updated dependencies [8a0ccbc]
- Updated dependencies [b405334]
- Updated dependencies [7b92e25]
- Updated dependencies [94a01eb]
  - @basaltkit/fastify@0.3.0
  - @basaltkit/core@0.3.0
  - @basaltkit/mailer@0.3.0
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
  - @basaltkit/fastify@0.1.0
  - @basaltkit/mailer@0.1.0
  - @basaltkit/queue@0.1.0
