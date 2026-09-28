---
'@basaltkit/audit-sqlite': minor
'@basaltkit/audit-prisma': minor
---

`SqliteAuditStore` and `PrismaAuditStore` implement the optional `AuditStore.auditTenants()`.

`Audit.verifyAll()` must also visit tenants whose rows were all written outside
a chain (a forged seq-less insert for a tenant that never had one). Without
`auditTenants()` it found them by scanning `query({})` — a read of the whole
trail on every run. Both stores now answer with one `SELECT DISTINCT` on the
tenant column (served by the existing `(tenant_id, at)` / `[tenantId, at]`
index); rows without a tenant come back as `undefined`, as in
`MemoryAuditStore`. No schema change.
