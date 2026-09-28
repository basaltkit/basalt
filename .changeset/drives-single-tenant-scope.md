---
'@basaltkit/drives': minor
---

The single-tenant store key is a reserved sentinel (framework audit, FA-030 — same fix as `@basaltkit/files`).

`SINGLE_TENANT_SCOPE` is now `'@single'` instead of `'default'`. `'default'` is a valid tenant id, so in an app without `@basaltkit/tenancy` a request carrying a tenant named `default` could `list` the app's drive connections, read and import through them, and `disconnect` them. `@` is outside the tenant-id grammar, and a context or explicit tenant equal to the sentinel is refused with the new `DriveTenantReservedError` (`DRIVE_TENANT_RESERVED`, 400).

The sentinel surfaces as `connection.tenantId`, but it is a store key, not a tenant id: in a single-tenant app leave `tenantId` out of calls instead of passing it back. The engine does so internally (`completeAuthorization` → `connect`, `importItem` → `download`), and `filesSink` no longer forwards it to `@basaltkit/files` — before, a single-tenant import uploaded under the tenant `'default'` rather than the files single-tenant key.

**Breaking (0.x minor) — migration:** a single-tenant app with persisted connections must re-key them once. Plain SQL is not enough: each `secret` is sealed with its `tenantId` as AES-GCM associated data, so re-seal it with the same key ring `Drives` uses:

```ts
import { DriveSecretBox, SINGLE_TENANT_SCOPE } from '@basaltkit/drives'

const box = new DriveSecretBox(keys)
for (const row of await db.driveConnection.findMany({ where: { tenantId: 'default' } })) {
  const context = { connectionId: row.id, provider: row.provider }
  const plain = box.open(row.secret, { ...context, tenantId: 'default' })
  const secret = box.seal(plain, { ...context, tenantId: SINGLE_TENANT_SCOPE })
  await db.driveConnection.update({ where: { id: row.id }, data: { tenantId: SINGLE_TENANT_SCOPE, secret } })
}
```

then move the import ledger (`UPDATE <ledger table> SET "tenantId" = '@single' WHERE "tenantId" = 'default'`). Skip it if `default` was ever a real tenant in that database. An authorization started before the upgrade fails its callback once (its `state` names the old key). No legacy fallback read is kept on purpose: it would re-open the collision in the other direction.
