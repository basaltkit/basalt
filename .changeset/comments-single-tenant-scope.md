---
'@basaltkit/comments': major
---

The single-tenant store key is a reserved sentinel (framework audit, FA-030 — same fix as `@basaltkit/files`).

`SINGLE_TENANT_SCOPE` is now `'@single'` instead of `'default'`. `'default'` is a valid tenant id, so in an app without `@basaltkit/tenancy` a request carrying a tenant named `default` could `list`/`get` the app's comments and `edit`/`resolve`/`remove` them. `@` is outside the tenant-id grammar, and a context or explicit tenant equal to the sentinel is refused with the new `CommentTenantReservedError` (`COMMENT_TENANT_RESERVED`, 400).

**Why major — migration:** single-tenant apps with persisted comments must re-key them once, or they read as missing:

```sql
-- @basaltkit/comments-prisma
UPDATE comments SET "tenantId" = '@single' WHERE "tenantId" = 'default';
-- @basaltkit/comments-sqlite
UPDATE comments SET tenant_id = '@single' WHERE tenant_id = 'default';
```

Skip it if `default` was ever a real tenant in that database — those rows belong to it. No legacy fallback read is kept on purpose: reading `'default'` for tenant-less calls would re-open the same collision in the other direction. `comment.tenantId` (and so hook payloads) of a single-tenant app now carries `'@single'`.
