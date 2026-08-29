# @basaltkit/cache

## 1.3.0

### Minor Changes

- a76d591: **Advisory — in multi-tenant apps, cache operations with no resolvable tenant scope now fail CLOSED by default.**
  
  `onMissingScope` defaulted to `'global'`: a `remember()`/`put()` outside request context (a background job, a boot task) silently read and wrote one namespace **shared across all tenants** — a tenant-A value could be served to tenant B. Now, when `@basaltkit/tenancy` is registered (detected via its `tenancy:active` metadata marker), `cachePlugin` defaults `onMissingScope` to `'error'`: such operations throw `MissingCacheScopeError` instead of silently widening.
  
  - **Single-tenant apps (no tenancy plugin) are untouched** — the global namespace keeps working.
  - An explicit `onMissingScope: 'global'` opts back in deliberately, and a custom `scope` function is left alone (its author owns the semantics).
  - `flush()` already always failed closed; reads/writes now match it.
  
  **If a background job starts throwing after upgrading:** wrap it in `runWithContext({ tenant })` for the tenant it serves, or pass `onMissingScope: 'global'` if cross-tenant sharing is genuinely intended.

## 1.2.0

### Minor Changes

- e015e1b: Add stale-while-revalidate to `remember`.

  `cache.remember(key, { ttl, staleFor }, factory)` serves a value fresh for `ttl`, then serves it **stale immediately** for a further `staleFor` window while a single background revalidation refreshes it; only after `ttl + staleFor` does a read block on the factory again. Concurrent stale reads dedupe into one background refresh (same stampede protection as `remember`), and a throwing refresh keeps serving stale until hard expiry instead of surfacing an error.

  - Freshness windows are gated in the Cache layer via an injectable `now` clock (`CacheOptions.now`), independent of driver eviction.
  - Works through `tags(...).remember(...)`; plain `get()` transparently unwraps SWR entries.
  - The plain `remember(key, ttl, factory)` signature is unchanged. New `SwrOptions` type exported.

## 1.1.0

### Minor Changes

- Security: **don't fail open to a shared global namespace when the tenant scope is absent.**
  - **`flush()` now fails closed** (throws `MissingCacheScopeError`) when a tenant-scoped cache resolves no tenant, instead of wiping the entire `basalt:*` namespace across _every_ tenant. A deliberate global cache (`scope: null`) still flushes its whole namespace, and a properly-scoped flush is unchanged.
  - **New `onMissingScope: 'error'`** option makes reads/writes fail closed too when no tenant resolves — recommended for multi-tenant apps, so a per-tenant value cached from a context that lost its tenant can't leak into the shared namespace and be read by another tenant. Default stays `'global'` (previous behavior) for compatibility.

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

### Minor Changes

- be55f2d: `cachePlugin` and `storagePlugin` now accept a custom driver **instance**, not just a built-in shortcut.

  - `cachePlugin({ driver })` accepts `'memory'`, `'redis'`, **or a `CacheDriver` instance** — so `@basaltkit/cache-tiered` (and any custom driver) plugs in directly.
  - A disk in `storagePlugin({ disks })` accepts `{ driver: 'local'|'s3', … }` **or `{ driver: <StorageDriver instance> }`** — so `@basaltkit/storage-gcs`, `@basaltkit/storage-azure` and custom drivers plug in directly.

  Both changes are backward compatible (the string shortcuts still work).

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0

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
