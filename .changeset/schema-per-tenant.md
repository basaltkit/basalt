---
"@machize/prisma": minor
---

Add schema-per-tenant isolation (the RFC's intermediate mode). `prismaPlugin`
gains a `schemaPerTenant` option: one database, one PostgreSQL schema per tenant,
where each tenant's client connects with `?schema=tenant_<id>` so Prisma sets the
search_path at connect time — reliable, unlike per-request search_path switching
on a shared pool. Reuses the existing LRU `TenantClientPool`. New helpers:
`tenantSchema()` (safe identifier), `schemaUrl()` (schema-scoped connection URL),
`provisionTenantSchema()` (CREATE SCHEMA IF NOT EXISTS, guarded against unsafe
names).
