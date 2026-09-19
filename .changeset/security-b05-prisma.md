---
"@basaltkit/prisma": major
---

Security hardening of the Prisma tenancy integration (fail closed by default):

- `tenancyExtension` now scopes `updateManyAndReturn`, refuses every client-level raw operation (`$queryRawTyped`, `$runCommandRaw`, …) and MongoDB `findRaw`/`aggregateRaw` inside a tenant context (`PRISMA_RAW_IN_TENANT`), and throws the new `UnscopedOperationError` (`PRISMA_UNSCOPED_OPERATION`) for any operation it cannot scope instead of running it unscoped.
- `tenancyExtension` now scopes nested relation writes (nested creates are stamped; `connect`, `set`, `update`, `delete`, … are narrowed to the tenant) and refuses update data that changes the tenant field (new `CrossTenantWriteError`, `PRISMA_CROSS_TENANT_WRITE`).
- `tenantSchema()` is now injective: canonical ids (`acme`, `acme_co`) keep their schema name; any other id gets a `__<hash>` suffix so distinct tenant ids can no longer share a schema. Tenants with non-canonical ids must rename their schema once (see the README upgrade note).
- `TenantClientPool` deduplicates concurrent first use of a tenant (no duplicate, leaked clients) and closes evicted clients with `$disconnect()` by default.
- Docs: `onMissingTenant` defaults to `'error'`; examples no longer configure `'bypass'` on the app's main client.
