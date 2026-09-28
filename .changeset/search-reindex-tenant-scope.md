---
'@basaltkit/search': major
'@basaltkit/search-postgres': minor
'@basaltkit/search-elasticsearch': minor
---

`reindex()` can rebuild one tenant without touching the others, and `search()` bounds `offset` and the authorize scan.

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
