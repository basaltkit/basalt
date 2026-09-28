# @basaltkit/search

## 2.0.0

### Major Changes

- e53db52: `reindex()` never guesses a tenant and never clears before it knows it can finish; `search()` validates paging and filters (framework audit, FA-050 and the search parts of FA-066).
  
  - **FA-050 — `reindex()` from inside a tenant filed every tenant-less record under that tenant.** A rebuild covers every tenant, so it now takes the tenant only from the rule's own `document`. A row without `tenantId` throws `TenantRequiredError` whenever a tenant could exist (`@basaltkit/tenancy` registered, or a tenant context active); only a single-tenant app with no context tenant files it under `SINGLE_TENANT_SCOPE`.
  - **FA-050 — `clear()` ran before the error.** With tenancy on and no context the index was wiped and *then* `TenantRequiredError` was thrown. `reindex()` now walks the `backfill` once to map and validate every row (tenant, reserved `'@single'`, a `backfill` that throws), and only then clears and writes in a second walk. Memory stays bounded by one page; rows that change between the walks can still fail the second one.
  - **FA-066 — paging.** `limit`/`offset` must be non-negative integers and `limit` ≤ `maxLimit` (default `1000`, new `searchPlugin({ maxLimit })` / `new Search({ maxLimit })`); otherwise `SearchPaginationError` (`SEARCH_INVALID_PAGINATION`, 400). A `limit: -1` used to reach the memory driver as `slice(0, -1)`.
  - **FA-066 — filters on undeclared fields.** For an index listed in `searchPlugin({ indexes })` (forwarded to the service; or `new Search({ indexes })`), a filter may only name a `filterable` field or `tenantId` — `SearchFilterNotFilterableError` (`SEARCH_FILTER_NOT_FILTERABLE`, 400). The memory, Postgres and Elasticsearch drivers filtered on any stored field, an oracle for values the index never declared. Indexes not listed are unchanged.
  - **FA-066 — filter values.** A value must be a string, a finite number, a boolean, or a flat array of those — `SearchFilterValueError` (`SEARCH_INVALID_FILTER_VALUE`, 400). `null`/`undefined` are refused rather than dropped (dropping would widen `{ ownerId: user?.id }` to every owner). `MeilisearchDriver` repeats the check, since it spliced any JSON (objects, nested arrays) into its filter DSL.
  - FA-066's `'default'` scope item was already closed by the `'@single'` sentinel (FA-030).
  
  **Why major — migration:**
  
  1. A sync rule whose `document` omits `tenantId` in a multi-tenant app now makes `reindex()` throw (it used to put every row in the calling tenant, or clear and throw). Return `tenantId` from `document`. (Rebuilding one tenant at a time is now safe — see `search-reindex-tenant-scope`.)
  2. `search()` with a `limit` over 1000 throws — pass `searchPlugin({ maxLimit })` if you page larger.
  3. Filters on a field not in the index's `filterable` throw — declare the field `filterable` (Meilisearch already required this).
  4. Filters with `null`/`undefined`/object values throw — omit the key when there is nothing to filter by.
- b69ea05: `reindex()` can rebuild one tenant without touching the others, and `search()` bounds `offset` and the authorize scan.
  
  - **Tenant-scoped rebuild.** `search.reindex(index, { tenantId?, all? })`. Inside a tenant context (a request, `tenancy.run`, `tenancy.forEach`) — or with `{ tenantId }` — it clears only that tenant's documents and writes only the backfill rows mapped to that tenant (other tenants' rows are validated, then skipped). `{ all: true }` clears and rebuilds the whole index, and is only allowed outside a tenant context. Until now `reindex()` always cleared the **whole** index, so the documented `tenancy.run(id, () => search.reindex(name))` over a database-per-tenant `backfill` left only the last tenant searchable. The "validate every row before any destructive step" guarantee is unchanged, and the scope is checked before the backfill is even read.
  - **New driver method `clearTenant(index, tenantId)`** (optional on `SearchDriver`), implemented by `MemorySearchDriver`, `MeilisearchDriver` (delete-by-filter, Meilisearch ≥ 1.2), `PostgresSearchDriver` (`DELETE … WHERE idx AND tenant_id`) and `ElasticsearchDriver` (`_delete_by_query` on a `tenantId` term). A custom driver without it gets `SearchDriverCapabilityError` (`SEARCH_DRIVER_UNSUPPORTED`, 501) for a scoped rebuild — before anything is read or cleared, never a fallback to `clear()`.
  - **Elasticsearch:** `clear()`/`clearTenant()` throw `ElasticsearchError` when `_delete_by_query` answers 200 with `failures` (version conflicts, shard errors), instead of letting a rebuild write over a half-cleared index.
  - **Paging bounds.** `offset` above `maxOffset` (default `10000`, Elasticsearch's own `max_result_window`) throws `SearchPaginationError`. An authorized search's scan is capped by a `maxScan` ceiling (default `10000`); the default budget (20 pages, floor 200) is clamped to it, and a per-call `maxScan` above it, or not a positive integer, throws `SearchPaginationError`. Both are `searchPlugin({ maxOffset, maxScan })` / `new Search({ … })` options.
  - New exports: `ReindexOptions`, `SearchReindexScopeError` (`SEARCH_REINDEX_SCOPE`, 400), `SearchDriverCapabilityError`, `DEFAULT_MAX_OFFSET`, `DEFAULT_MAX_SCAN`.
  
  **Why major — migration (`@basaltkit/search`):**
  
  1. With `@basaltkit/tenancy` registered, a bare `search.reindex(name)` **outside** a tenant context now throws `SearchReindexScopeError`. For the old whole-index rebuild (jobs, CLI, deploy scripts), write `search.reindex(name, { all: true })`.
  2. `reindex()` **inside** a tenant context now rebuilds only that tenant (it used to clear and rebuild every tenant). If you relied on the old behaviour, move the call outside the context and pass `{ all: true }` — which is refused inside a tenant context.
  3. A single-tenant app (no tenancy) is unchanged: a bare `reindex(name)` still rebuilds the whole index.
  4. A custom `SearchDriver` keeps compiling; implement `clearTenant(index, tenantId)` to support tenant-scoped rebuilds.
  5. `search()` with `offset` over 10000, or an explicit `maxScan` over 10000, throws — raise `searchPlugin({ maxOffset, maxScan })` if you need to, or narrow deep pages with a filter.
- e54b7b1: The single-tenant scope is a reserved sentinel (framework audit, FA-030 — same fix as `@basaltkit/files`).
  
  `SINGLE_TENANT_SCOPE` is now `'@single'` instead of `'default'`. `'default'` is a valid tenant id, so in an app without `@basaltkit/tenancy` a request carrying a tenant named `default` found the app's documents, and could overwrite or `remove` them. `@` is outside the tenant-id grammar, and a tenant equal to the sentinel — from the context, an explicit argument, a document's `tenantId`, or a row mapped by `reindex()` — is refused with the new `SearchTenantReservedError` (`SEARCH_TENANT_RESERVED`, 400).
  
  **Why major — migration:** a single-tenant app's existing documents are indexed under `'default'` and no longer match. The index is derived data, so rebuild it once — `search.reindex(name)` for rules with a `backfill`, or re-run your own indexing. With `@basaltkit/search-postgres` you can re-key in place instead:
  
  ```sql
  UPDATE basalt_search
     SET tenant_id = '@single', document = jsonb_set(document, '{tenantId}', '"@single"')
   WHERE tenant_id = 'default';
  ```
  
  Meilisearch and Elasticsearch/OpenSearch derive the primary key from the tenant, so there only a rebuild works (clear the stale `'default'` documents, which `reindex()` does). Skip it if `default` was ever a real tenant. No legacy fallback read is kept on purpose: it would re-open the collision in the other direction.

### Patch Changes

- Updated dependencies [e54b7b1]
  - @basaltkit/core@1.5.0

## 1.6.1

### Patch Changes

- b0cc59f: Close documentation drift where the docs promised more than the code delivered.
  
  - **exports:** new `exports.stream(definition, data, format, { chunkSize? })` renders CSV/TSV/JSON/NDJSON incrementally — rows are pulled one at a time from an array or `AsyncIterable` and the file is emitted as an `AsyncIterable<Buffer>` in ~64 KiB chunks (byte-identical to `run()`), so memory stays bounded for large datasets. Formatters opt in with the new optional `ExportFormatter.renderStream()`; buffer-only formatters (XLSX, PDF) are rejected with `ExportNotStreamableError` (`EXPORT_NOT_STREAMABLE`, 400). Adds `exports.streamableFormats()`. The README no longer claims that `run()` avoids loading everything into memory: it buffers by design.
  - **exports-xlsx:** README states that the XLSX formatter is buffer-only.
  - **backup:** README no longer calls dump artifacts "immutable" (they are plain `disk.put()` writes); documents how to get immutability with bucket versioning + S3 Object Lock as the application's responsibility.
  - **comments:** README mention-notification example uses the real `notifier.notify(recipient, definition, data)` API instead of a non-existent `notifications.to(...).send(...)`.
  - **search:** README documents every driver — including `@basaltkit/search-postgres` and `@basaltkit/search-elasticsearch`.
  - **core:** README explains that `runWithContext` must await lazy thenables (Prisma queries) inside an async callback, otherwise they execute outside the context (`PRISMA_TENANT_MISSING`).
  - **testing:** README documents `withTenant` and lists the fakes that are not provided yet.
- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2

## 1.6.0

### Minor Changes

- fb85c40: Security hardening (deep audit 2026-09, batch B07).
  
  - `@basaltkit/files`: `fileRoutes()` now enforces object-level authorization — owner-only (`uploadedBy === ctx().user.id`) by default, with `authorize(action, record, user)` and `shared: true` as explicit options; files the caller may not reach answer 404 (including `DELETE`). `POST /files/:id/url` validates `expiresIn` (positive, at most `maxUrlTtl`, default `1h`) and answers 400 otherwise. The `maxTotalBytes` quota is serialised per tenant and re-checked after insert, so concurrent uploads can no longer exceed it. `MemoryFileStore` uses tuple-safe keys.
  - `@basaltkit/comments`: bodies are capped (`maxBodyLength`, default 10 000 characters) and mentions per comment are capped (`maxMentions`, default 50); new `resolveMentions(ids, tenantId)` option filters who can be mentioned. `commentRoutes({ authorize })` adds a per-resource authorization hook; by default resolve/reopen are restricted to the comment's author, like edit/delete. `MemoryCommentStore` uses tuple-safe keys.
  - `@basaltkit/audit-viewer`: `auditViewerRoutes()` requires an authorization guard via `meta` (e.g. `{ can: 'audit:read' }`) merged into every route, and throws `AuditViewerUnguardedError` without one unless `allowAnyAuthenticated: true` is passed explicitly.
  - `@basaltkit/files`, `@basaltkit/comments`, `@basaltkit/audit-viewer`, `@basaltkit/search`: inside a tenant context an explicit `tenantId` argument must match the context tenant (it can no longer widen a call to another tenant); a mismatch throws a `*_TENANT_MISMATCH` error (403). `search.reindex()` still trusts the tenant each sync rule maps.

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
