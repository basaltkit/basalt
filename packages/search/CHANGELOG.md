# @basaltkit/search

## 1.5.0

### Minor Changes

- 9b98f18: Row-level authorization, and rebuilding an index from the rules that feed it.
  
  **`authorize`** — search was the one surface with no answer for per-row
  visibility. A driver filters by the fields declared `filterable` and nothing
  else, so in a product where a confidential matter is visible only to the people
  assigned to it, search was the single place the package left unsolved. Both ways
  around it were bad:
  
  - **Copy the ACL into the index.** Fast, and it makes the index a second copy of
    an access rule. Removing someone from a confidential matter changes the
    database and not the index, and search keeps showing it to them until somebody
    reindexes. A stale index gives an old result; a stale ACL gives an
    unauthorized one.
  - **Over-fetch and trim.** Correct, but the over-fetch factor is a guess and a
    caller with little access gets short pages.
  
  ```ts
  search.search('matters', q, { limit: 20, authorize: (hits) => filterByPolicy(hits) })
  ```
  
  The hook runs after the driver, which is what lets the package keep asking until
  the page is full — the thing a caller cannot do from outside. `offset` counts
  authorized hits, so page two continues where page one ended. `maxScan` bounds
  the work, and `totalExact` says whether `total` is the whole truth: a driver's
  total counts rows the caller may not see, and rendering it would put "42
  results" above three rows.
  
  Callers with no hook are unchanged: one driver call, same behaviour, same cost.
  
  **`backfill` and `search.reindex(index)`** — an index fed by events knows only
  what was created after the rule existed. An application adding search to data it
  already has gets a box that returns nothing for everything old, and an empty
  result is indistinguishable from "there is none".
  
  ```ts
  syncRule({
    hook: 'matter:opened',
    index: 'matters',
    document: ({ matter }) => ({ id: matter.id, tenantId: matter.tenantId, number: matter.number }),
    backfill: async function* () { /* pages of the same payload */ },
  })
  
  await search.reindex('matters')
  ```
  
  `backfill` yields **hook payloads**, not rows, so one `document` function serves
  both directions. A second mapping written by hand is the drift this prevents:
  let it disagree and the same search returns different things depending on
  whether a record predates the last rebuild. The index is cleared first — a
  rebuild that appends leaves documents for records that no longer exist — and an
  index with no `backfill` raises rather than reporting a rebuild that did
  nothing.

## 1.4.0

### Minor Changes

- f3703a1: Search works in apps without tenancy, and indexing no longer disagrees with querying.
  
  `search()` and `remove()` threw `TenantRequiredError` (`400 SEARCH_TENANT_REQUIRED`) when no tenant could be resolved, while `index()`/`bulk()` required `tenantId` on every `SearchDocument`. A single-tenant app therefore had to invent a tenant id to index — and then still could not read it back.
  
  Both sides now resolve the tenant through the same rule. `searchPlugin` reads tenancy's `tenancy:active` metadata marker (a signal, not an import) and fails closed only when tenancy is registered; without it, index and query share the exported `SINGLE_TENANT_SCOPE` (`'default'`) and always agree.
  
  `index()`/`bulk()` accept the new, wider `SearchInput` type where `tenantId` is optional — `Search` fills it in before the driver sees it, so the `SearchDocument` driver contract and every existing driver are unchanged. `SyncRule`'s `document`/`remove` callbacks widen the same way. `new Search(options, tenancyActive?)` takes an optional second argument.

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
