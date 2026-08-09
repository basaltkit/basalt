# File uploads

`@basaltkit/files` is an upload pipeline over [`@basaltkit/storage`](/reference/packages):
it validates the content type and size, enforces a per-tenant storage quota,
writes the bytes tenant-scoped, records metadata, and emits hooks for
out-of-band processing (antivirus, thumbnails).

## Setup

```ts
import { filesPlugin, FILES, fileRoutes } from '@basaltkit/files'

filesPlugin({
  disk: 'uploads',                                   // a disk name or a Disk instance
  validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
  maxTotalBytes: 1_000_000_000,                      // per-tenant quota (1 GB)
})
// routes: [...fileRoutes()]  →  GET /files, GET /files/:id, POST /files/:id/url, DELETE /files/:id
```

## Upload

Uploading is multipart (adapter-specific), so call the service from your own
handler — the rest is done for you:

```ts
const files = app.container.get(FILES)
const record = await files.upload(buffer, {
  name: 'contract.pdf', contentType: 'application/pdf', uploadedBy: user.id,
}) // tenantId comes from ctx().tenant
```

`upload` validates, checks the quota, stores the bytes **isolated by tenant**,
records metadata (name, size, SHA-256 checksum, uploader) and emits
`file:uploaded`. It returns the `FileRecord`.

## Quota

`maxTotalBytes` is a built-in per-tenant cap. To tie storage to a plan, wire
`checkQuota` (it throws to reject) into `@basaltkit/subscriptions`:

```ts
filesPlugin({ disk: 'uploads', checkQuota: (tenantId, size) =>
  subscriptions.features(tenantId).consume('storage_bytes', size) })
```

## Post-processing hooks

The typical pattern: on `file:uploaded`, dispatch a queue job that scans or
transforms the file, then record the result with `markScanned`:

```ts
hooks.on('file:uploaded', ({ file }) => ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))
// in the job, once done:
await files.markScanned(id, { clean: true }, tenantId) // emits file:scanned
```

Also available: `download`, `temporaryUrl` (signed), `get`/`list`, `delete`
(emits `file:deleted`). Errors: `FileTooLargeError` (413),
`FileTypeNotAllowedError` (415), `StorageQuotaExceededError` (402).

Storage access runs in the resolved tenant's context, so files stay isolated
even when `upload` is called from a background job.
