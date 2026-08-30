---
'@basaltkit/search': minor
---

Search works in apps without tenancy, and indexing no longer disagrees with querying.

`search()` and `remove()` threw `TenantRequiredError` (`400 SEARCH_TENANT_REQUIRED`) when no tenant could be resolved, while `index()`/`bulk()` required `tenantId` on every `SearchDocument`. A single-tenant app therefore had to invent a tenant id to index — and then still could not read it back.

Both sides now resolve the tenant through the same rule. `searchPlugin` reads tenancy's `tenancy:active` metadata marker (a signal, not an import) and fails closed only when tenancy is registered; without it, index and query share the exported `SINGLE_TENANT_SCOPE` (`'default'`) and always agree.

`index()`/`bulk()` accept the new, wider `SearchInput` type where `tenantId` is optional — `Search` fills it in before the driver sees it, so the `SearchDocument` driver contract and every existing driver are unchanged. `SyncRule`'s `document`/`remove` callbacks widen the same way. `new Search(options, tenancyActive?)` takes an optional second argument.
