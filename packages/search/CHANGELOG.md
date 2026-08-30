# @basaltkit/search

## 1.3.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.3.0

### Minor Changes

- Validate the Meilisearch index name at the driver boundary (`SearchIndexNameError`) so a crafted name can not break out of the REST URL path.

## 1.2.0

### Minor Changes

- Security: **the Meilisearch driver validates filter field names.** A filter key is interpolated into Meilisearch's filter DSL, so a crafted name (e.g. `x" OR tenantId = "victim`) could break out of the mandatory `tenantId` scope and read another tenant's documents. Field names are now required to be bare, optionally-dotted identifiers; anything else throws the new `SearchFilterFieldError` before any request is sent. Values were already quoted and are unaffected.

## 1.1.0

### Minor Changes

- `searchPlugin` no longer crashes app boot when an index fails to register (a
  search backend that's down or misconfigured). It now logs a warning and boots
  anyway — search stays degraded until the backend is reachable — so an outage
  never blocks unrelated work, including CLI commands that don't use search. Set
  `failOnRegisterError: true` to restore the strict, throw-on-boot behavior.

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

### Minor Changes

- 49d9723: New package: `@basaltkit/search` — tenant-scoped full-text search.

  A `Search` service indexes and queries documents through a pluggable `SearchDriver`, with every query forced to the caller's `tenantId` so results never leak between tenants. `MemorySearchDriver` gives real term-frequency + prefix relevance (AND semantics, field restriction, exact/array filters) for dev and tests with no external service; `MeilisearchDriver` targets the Meilisearch REST API for production (compound per-tenant primary keys, automatic `tenantId` filtering, injectable `fetch` for tests). `searchPlugin({ indexes, sync })` registers indexes and keeps them in sync with domain hooks via `syncRule({ hook, index, document | remove })`. The tenant is read from `options.tenantId` or the request context. Fully unit-tested — relevance, tenant isolation, filters, the sync bridge, and the Meilisearch request shapes — without any external engine.

### Patch Changes

- @basaltkit/core@0.10.0
