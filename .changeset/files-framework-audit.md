---
'@basaltkit/files': major
---

Security fixes from the framework audit (FA-030, FA-031, FA-032).

- **Single-tenant store key is a reserved sentinel (FA-030).** `SINGLE_TENANT_SCOPE` is now `'@single'` instead of `'default'`. `'default'` is a valid tenant id, so a tenant named `default` could `get`/`list` a single-tenant app's records and `delete` them (removing the row, and leaving the object orphaned under the root). `@` is outside the tenant-id grammar, and a context or explicit tenant equal to the sentinel is refused with the new `FileTenantReservedError` (`FILE_TENANT_RESERVED`, 400). `fileScope()` — and so `@basaltkit/files-versions` — uses the new key.
- **A failed metadata insert no longer leaves an orphan object (FA-031).** When `store.create` throws after the bytes were written (buffered or streamed path), the object is deleted (best effort) before the error propagates, so a failed upload leaves neither a record nor an object — as the README promised.
- **Sniffing never promotes `application/octet-stream` to an active type (FA-032).** With `validate.sniff`, an upload declared `application/octet-stream` (or with no type) is promoted to the detected type only when that is inert — PDF, raster images, audio, video, ZIP/Office (new `isInertType()` export). HTML, SVG, XML, scripts and executables sent as octet-stream are refused with `FileTypeMismatchError` instead of being stored as `text/html`/`image/svg+xml` (which `image/*` allowlists admitted). Storing one takes declaring it, and `allowedTypes` judges that declaration.

**Why major — migration:** single-tenant apps with persisted records (e.g. `@basaltkit/files-prisma`) must re-key them once, or they read as missing:

```sql
UPDATE files         SET "tenantId" = '@single' WHERE "tenantId" = 'default';
UPDATE file_versions SET "tenantId" = '@single' WHERE "tenantId" = 'default'; -- with @basaltkit/files-versions
```

Skip it if `default` was ever a real tenant in that database — those rows belong to it. No legacy fallback read is kept on purpose: reading `'default'` for tenant-less calls would re-open the same collision in the other direction. Also: octet-stream uploads of HTML/SVG/XML/executables are now refused, and (through `@basaltkit/storage` 4) a hand-built `Disk` passed to `Files` in a single-tenant app needs `scope: null`.
