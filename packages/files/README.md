<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

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

### Options reference

`filesPlugin(options)` — registers a `Files` singleton under the `FILES` token:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `disk` | `Disk \| string` | — (required) | A `Disk` instance, or the name of a disk declared in `storagePlugin`. A string is resolved from the `STORAGE` token at first use. |
| `validate` | `FileValidation` | `{ maxSize: DEFAULT_MAX_FILE_SIZE }` | Size limit and content-type allowlist. See below — the size cap applies **even if you pass nothing**. |
| `maxTotalBytes` | `number` | — (no quota) | Built-in per-tenant quota: rejects an upload when the tenant's stored bytes plus this file would exceed it. Costs one `store.totalSize()` read per upload. |
| `checkQuota` | `(tenantId, size) => Promise<void> \| void` | — | Custom quota check, run after the built-in one. Throw to reject — this is where you wire `@basaltkit/subscriptions` plan limits. |
| `store` | `FileStore` | `MemoryFileStore` | Where file metadata lives. In-memory means records vanish on restart while the bytes stay in storage — implement `FileStore` over your database in production. |

`FileValidation`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `maxSize` | `number` | `DEFAULT_MAX_FILE_SIZE` = **25 MiB** (`26214400`) | Per-file byte cap. Secure by default: uploads are capped even when you configure nothing. Raise it, or pass `Infinity` to disable. |
| `allowedTypes` | `string[]` | — (anything) | Content-type allowlist. Supports trailing wildcards: `'image/*'` matches `image/png`. |

`DEFAULT_MAX_FILE_SIZE` is exported, so you can express a limit relative to it.

> The cap applies to the buffer you hand to `upload()`. Your HTTP adapter's own
> body limit still applies first, and `@basaltkit/storage` itself caps nothing
> unless you pass `maxBytes` per `put()`.

### `class Files`

| Method | Description |
|---|---|
| `upload(content, input)` | Validates, enforces quota, stores, records metadata, emits `file:uploaded`. |
| `download(id, tenantId?)` | `{ record, content }`. |
| `temporaryUrl(id, expiresIn, tenantId?, options?)` | Signed URL. Served `Content-Disposition: attachment` by default; pass `{ disposition: 'inline' }` only when top-level rendering is deliberate — an uploaded HTML/SVG file served inline is stored XSS on the storage origin. Embedded `<img>`/`<video>` uses render regardless. |
| `get(id, tenantId?)` · `list(tenantId?)` | Metadata. |
| `delete(id, tenantId?)` | Deletes bytes + metadata; emits `file:deleted`. |
| `markScanned(id, result, tenantId?)` | Marks as scanned; emits `file:scanned`. |

Without an explicit `tenantId`, it uses `ctx().tenant.id`; without a tenant, it throws `FileTenantRequiredError`. Storage access runs in the resolved tenant's context, so files stay isolated even from a background job.

### Failure modes

| Error | Code | HTTP | When |
|---|---|---|---|
| `FileTooLargeError` | `FILE_TOO_LARGE` | 413 | The buffer exceeds `validate.maxSize` — 25 MiB when you configured nothing. |
| `FileTypeNotAllowedError` | `FILE_TYPE_NOT_ALLOWED` | 415 | `contentType` doesn't match `validate.allowedTypes`. |
| `StorageQuotaExceededError` | `FILE_QUOTA_EXCEEDED` | 402 | The tenant's total stored bytes plus this upload would pass `maxTotalBytes`. |
| `FileNotFoundError` | `FILE_NOT_FOUND` | 404 | `download` / `temporaryUrl` / `markScanned` for an id absent from this tenant's metadata store. |
| `FileTenantRequiredError` | `FILE_TENANT_REQUIRED` | 400 | No `tenantId` argument and no `ctx().tenant` — every operation is tenant-scoped and fails closed rather than querying unscoped. |

All extend `BasaltError` and declare a `status`, so the adapters map them to the
HTTP code above with the real error `code` in the body. Errors thrown by the
underlying disk (`STORAGE_*`) do **not** — they surface as 500 `INTERNAL_ERROR`.

- **`FILE_NOT_FOUND` for a file that exists in the bucket** — the metadata
  record is gone, not the bytes. `MemoryFileStore` loses everything on restart;
  wire a durable `FileStore`.
- **`FILE_TOO_LARGE` at exactly 25 MiB** — that's the default, not your adapter.
  Set `validate: { maxSize: … }`.
- **`FILE_TENANT_REQUIRED` inside a queue job** — jobs don't inherit the request
  context. Pass `tenantId` explicitly, or run the job body inside
  `tenancy.run(tenantId, …)`.

### Hooks & events

| Hook | Payload | When |
|---|---|---|
| `file:uploaded` | `{ file: FileRecord }` | After the bytes are written and the metadata recorded. |
| `file:deleted` | `{ tenantId: string; id: string }` | After the bytes and the record are removed. |
| `file:scanned` | `{ file: FileRecord }` | After `markScanned()` records an out-of-band scan result. |

They are declared on `BasaltHooks`, so `hooks.on('file:uploaded', …)` is fully
typed.

## How it connects to other modules

- **`@basaltkit/storage`** — where the bytes live (local/S3/GCS), with tenant isolation.
- **`@basaltkit/subscriptions`** — hook `checkQuota` into `features(tenant).consume(...)` for plan-based quotas.
- **`@basaltkit/queue`** — processes `file:uploaded` outside the request (antivirus, thumbnails).
- **`@basaltkit/tenancy`** — supplies the tenant from the context.

Guides: [Files & uploads](/guide/files) · [Storage](/guide/storage) · [Queues](/guide/queues).
