# @basaltkit/search-elasticsearch

## 2.0.0

### Major Changes

- e53db52: `index()`, `bulk()` and `remove()` address the same `_id` again for ids with URL-special characters (framework audit, FA-061).
  
  The document id is `<encodeURIComponent(tenantId)>:<encodeURIComponent(id)>`. The `_bulk` body carried it verbatim, but the `/_doc/<id>` path put it in raw, and Elasticsearch percent-decodes path segments: `acme:a%20b` in the path became the `_id` `acme:a b`. So `remove()` of a bulk-indexed document whose id held a space, `/`, `%`, `?`, `#`, `+`, a non-ASCII letter, … deleted nothing (404, swallowed) and it stayed searchable; `index()` plus `bulk()` of one document stored two; and on the single-document path tenant `a:b` + id `c` still collided with tenant `a` + id `b:c`. The path now encodes the id once more (`:` kept literal), so ES decodes it to exactly the bulk `_id`. The package's own test compared the two after decoding both, which is the step ES skips for the bulk body — it now models ES.
  
  **Why major — migration:** documents written by `index()` (single, not bulk) whose tenant or id contained such a character were stored under the decoded `_id`; they are now unreachable by `remove()`/`index()` and would be duplicated. Plain UUID/slug/numeric ids are byte-for-byte unchanged. If any of your ids can contain those characters, rebuild the index once — `search.reindex(name, { all: true })` (it clears first) or clear and re-run your indexing.

### Minor Changes

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

### Patch Changes

- Updated dependencies [e53db52]
- Updated dependencies [b69ea05]
- Updated dependencies [e54b7b1]
  - @basaltkit/search@2.0.0

## 1.2.0

### Minor Changes

- 104cfb3: `index()` and `bulk()` now write the same `_id` for the same document.
  
  The driver had **two** id builders: `bulk()` used the raw `${tenantId}:${id}` while `index()` and `remove()` used a per-segment percent-encoded form. For any id carrying a URL-special character (a space, `/`, `#`, `%`), the same document indexed singly and in bulk landed under two different `_id`s — silent duplicates — and `remove()` could not delete a bulk-indexed one. There is now one definition, the encoded form, used everywhere.
  
  Encoding the segments also closes the `:` ambiguity the review flagged: tenant `a:b` + id `c` no longer collides with tenant `a` + id `b:c`, which previously overwrote one tenant's document with another's (a write-side data loss; reads were never leaked, the stored `tenantId` still gates search). This matches how the Meilisearch driver already encodes its primary key.
  
  **Upgrade note.** Plain UUID/slug ids are unaffected — `encodeURIComponent` leaves them untouched, so nothing re-indexes. Only documents whose tenant id or document id contains a special character change address; re-index them if you have any.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/search@1.3.2

## 1.1.1

### Patch Changes

- Validate index names / prefix at the driver boundary so a crafted name can not break out of the REST URL path.

## 1.1.0

### Minor Changes

- Security: **an index with no configured `fields` now searches via `simple_query_string`, not `query_string`.** The `query_string` query exposes full Lucene syntax to raw user input — field probing (`_index:*`), unbounded leading wildcards, and regex that can pin a node (DoS). `simple_query_string` never throws on malformed input and can't reach fields the user wasn't given. Indexes with declared fields (which use `multi_match`) are unaffected.

## 1.0.1

### Patch Changes

- Validated end-to-end against a live Elasticsearch 8.x cluster (index, search,
  `term`/`terms` filters, paging with an exact total, `bulk`, `remove`, and
  tenant isolation). No code changes — docs only.

## 1.0.0

### Initial release

- Elasticsearch / OpenSearch driver for the `@basaltkit/search` `SearchDriver`
  contract, talking to the REST API directly (no SDK) with an injectable
  `fetch`. `register` maps text (`.keyword` sub-field) + keyword fields; `search`
  uses `multi_match` with `track_total_hits` and `term`/`terms` filters.
  Tenant-scoped throughout: compound `<tenantId>:<id>` document ids and a
  mandatory `tenantId` filter on every search. Idempotent `register`, 404-safe
  `remove`, NDJSON `bulk`.
