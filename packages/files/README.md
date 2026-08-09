# @basaltkit/files

**Upload** pipeline for Basalt, built on top of [`@basaltkit/storage`](https://www.npmjs.com/package/@basaltkit/storage): validates (type/size), enforces **per-tenant quota**, stores the bytes, records metadata, and fires **hooks** (antivirus, thumbnails). You need this module when users upload files — attachments, avatars, documents — and you want to do it safely and with tenant isolation.

## What this module solves

Saving an upload "by hand" involves validating type/size, writing to storage in the right place (isolated per tenant), recording metadata (name, size, checksum, who uploaded it), enforcing the plan's quota, and triggering post-processing (antivirus scanning, thumbnails). This module does all of that in one call, leaving post-processing to hooks.

## Installation

```bash
pnpm add @basaltkit/files @basaltkit/storage
```

Depends on `@basaltkit/core`, `@basaltkit/storage`, and `@basaltkit/fastify` (routes). Configure a disk in `@basaltkit/storage` (local in dev, S3/GCS in production).

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { filesPlugin, FILES, fileRoutes } from '@basaltkit/files'
import { fastifyPlugin } from '@basaltkit/fastify'

const app = await createApp({
  plugins: [
    // ... storagePlugin({ disks: { uploads: ... } }) and tenancyPlugin
    filesPlugin({
      disk: 'uploads',                         // disk name (or a Disk instance)
      validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
      maxTotalBytes: 1_000_000_000,            // per-tenant quota (1 GB)
    }),
    fastifyPlugin({ routes: [...fileRoutes()] }),
  ],
}).boot()

const files = app.container.get(FILES)
const record = await files.upload(buffer, { name: 'contract.pdf', contentType: 'application/pdf', tenantId: 'acme', uploadedBy: 'u1' })
```

The upload validates, checks the quota, writes the bytes **isolated per tenant**, records the metadata (including a SHA-256 `checksum`), and emits `file:uploaded`.

## Receiving an upload over HTTP

The upload itself is *multipart* (adapter-specific), so there's no ready-made route for it. In your handler, read the file and call the service:

```ts
// example with Fastify and @fastify/multipart
app.post('/upload', async (req) => {
  const part = await req.file()
  const buffer = await part.toBuffer()
  return files.upload(buffer, { name: part.filename, contentType: part.mimetype })
  // tenantId comes from the request context (tenancy)
})
```

The other operations have ready-made routes via `fileRoutes()`:

| Route | Description |
|---|---|
| `GET /files` | Lists the current tenant's files. |
| `GET /files/:id` | A file's metadata. |
| `POST /files/:id/url` `{ expiresIn? }` | Temporary signed URL. |
| `DELETE /files/:id` | Deletes bytes + metadata. |

## Post-processing with hooks

The typical pattern: on `file:uploaded`, dispatch a job (with `@basaltkit/queue`) that scans/processes the file and then calls `markScanned`:

```ts
hooks.on('file:uploaded', ({ file }) => ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))

// in the job, after scanning:
await files.markScanned(id, { clean: true }, tenantId) // emits file:scanned
```

## API reference

### `filesPlugin(options)`

| Option | Type | Description |
|---|---|---|
| `disk` | `Disk \| string` | A `Disk` instance or the name of a `@basaltkit/storage` disk. |
| `validate` | `{ maxSize?, allowedTypes? }` | Size limit and allowed types (`image/*` accepts wildcards). |
| `maxTotalBytes` | `number` | Total quota per tenant. |
| `checkQuota` | `(tenantId, size) => void` | Custom quota check (e.g. hook into `@basaltkit/subscriptions`). Throw to reject. |
| `store` | `FileStore` | Metadata persistence. Default: in-memory. |

Registers the `FILES` token.

### `class Files`

| Method | Description |
|---|---|
| `upload(content, input)` | Validates, enforces quota, stores, records metadata, emits `file:uploaded`. |
| `download(id, tenantId?)` | `{ record, content }`. |
| `temporaryUrl(id, expiresIn, tenantId?)` | Signed URL. |
| `get(id, tenantId?)` · `list(tenantId?)` | Metadata. |
| `delete(id, tenantId?)` | Deletes bytes + metadata; emits `file:deleted`. |
| `markScanned(id, result, tenantId?)` | Marks as scanned; emits `file:scanned`. |

Without an explicit `tenantId`, it uses `ctx().tenant.id`; without a tenant, it throws `FileTenantRequiredError`. Storage access runs in the resolved tenant's context, so files stay isolated even from a background job.

Errors: `FileTooLargeError` (413), `FileTypeNotAllowedError` (415), `StorageQuotaExceededError` (402), `FileNotFoundError` (404).

## How it connects to other modules

- **`@basaltkit/storage`** — where the bytes live (local/S3/GCS), with tenant isolation.
- **`@basaltkit/subscriptions`** — hook `checkQuota` into `features(tenant).consume(...)` for plan-based quotas.
- **`@basaltkit/queue`** — processes `file:uploaded` outside the request (antivirus, thumbnails).
- **`@basaltkit/tenancy`** — supplies the tenant from the context.
