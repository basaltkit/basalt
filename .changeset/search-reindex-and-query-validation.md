---
'@basaltkit/search': major
---

`reindex()` never guesses a tenant and never clears before it knows it can finish; `search()` validates paging and filters (framework audit, FA-050 and the search parts of FA-066).

- **FA-050 — `reindex()` from inside a tenant filed every tenant-less record under that tenant.** A rebuild covers every tenant, so it now takes the tenant only from the rule's own `document`. A row without `tenantId` throws `TenantRequiredError` whenever a tenant could exist (`@basaltkit/tenancy` registered, or a tenant context active); only a single-tenant app with no context tenant files it under `SINGLE_TENANT_SCOPE`.
- **FA-050 — `clear()` ran before the error.** With tenancy on and no context the index was wiped and *then* `TenantRequiredError` was thrown. `reindex()` now walks the `backfill` once to map and validate every row (tenant, reserved `'@single'`, a `backfill` that throws), and only then clears and writes in a second walk. Memory stays bounded by one page; rows that change between the walks can still fail the second one.
- **FA-066 — paging.** `limit`/`offset` must be non-negative integers and `limit` ≤ `maxLimit` (default `1000`, new `searchPlugin({ maxLimit })` / `new Search({ maxLimit })`); otherwise `SearchPaginationError` (`SEARCH_INVALID_PAGINATION`, 400). A `limit: -1` used to reach the memory driver as `slice(0, -1)`.
- **FA-066 — filters on undeclared fields.** For an index listed in `searchPlugin({ indexes })` (forwarded to the service; or `new Search({ indexes })`), a filter may only name a `filterable` field or `tenantId` — `SearchFilterNotFilterableError` (`SEARCH_FILTER_NOT_FILTERABLE`, 400). The memory, Postgres and Elasticsearch drivers filtered on any stored field, an oracle for values the index never declared. Indexes not listed are unchanged.
- **FA-066 — filter values.** A value must be a string, a finite number, a boolean, or a flat array of those — `SearchFilterValueError` (`SEARCH_INVALID_FILTER_VALUE`, 400). `null`/`undefined` are refused rather than dropped (dropping would widen `{ ownerId: user?.id }` to every owner). `MeilisearchDriver` repeats the check, since it spliced any JSON (objects, nested arrays) into its filter DSL.
- FA-066's `'default'` scope item was already closed by the `'@single'` sentinel (FA-030).

**Why major — migration:**

1. A sync rule whose `document` omits `tenantId` in a multi-tenant app now makes `reindex()` throw (it used to put every row in the calling tenant, or clear and throw). Return `tenantId` from `document`. `reindex()` still clears the **whole** index: never call it once per tenant.
2. `search()` with a `limit` over 1000 throws — pass `searchPlugin({ maxLimit })` if you page larger.
3. Filters on a field not in the index's `filterable` throw — declare the field `filterable` (Meilisearch already required this).
4. Filters with `null`/`undefined`/object values throw — omit the key when there is nothing to filter by.
