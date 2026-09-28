---
'@basaltkit/search': major
---

The single-tenant scope is a reserved sentinel (framework audit, FA-030 — same fix as `@basaltkit/files`).

`SINGLE_TENANT_SCOPE` is now `'@single'` instead of `'default'`. `'default'` is a valid tenant id, so in an app without `@basaltkit/tenancy` a request carrying a tenant named `default` found the app's documents, and could overwrite or `remove` them. `@` is outside the tenant-id grammar, and a tenant equal to the sentinel — from the context, an explicit argument, a document's `tenantId`, or a row mapped by `reindex()` — is refused with the new `SearchTenantReservedError` (`SEARCH_TENANT_RESERVED`, 400).

**Why major — migration:** a single-tenant app's existing documents are indexed under `'default'` and no longer match. The index is derived data, so rebuild it once — `search.reindex(name)` for rules with a `backfill`, or re-run your own indexing. With `@basaltkit/search-postgres` you can re-key in place instead:

```sql
UPDATE basalt_search
   SET tenant_id = '@single', document = jsonb_set(document, '{tenantId}', '"@single"')
 WHERE tenant_id = 'default';
```

Meilisearch and Elasticsearch/OpenSearch derive the primary key from the tenant, so there only a rebuild works (clear the stale `'default'` documents, which `reindex()` does). Skip it if `default` was ever a real tenant. No legacy fallback read is kept on purpose: it would re-open the collision in the other direction.
