# File uploads

`@basaltkit/files` is an upload pipeline over [`@basaltkit/storage`](/reference/packages):
it validates the content type and size, enforces a per-tenant storage quota,
writes the bytes tenant-scoped, records metadata, and emits hooks for
out-of-band processing (antivirus, thumbnails).

[[toc]]

## Setup

`filesPlugin` sits on top of a [`@basaltkit/storage`](/guide/storage) disk —
register a disk first, then point `filesPlugin` at it by name (or pass a `Disk`
instance), and mount the read/manage routes through your adapter:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { storagePlugin } from '@basaltkit/storage'
import { FILES, filesPlugin, fileRoutes } from '@basaltkit/files'

export const app = await createApp({
  plugins: [
    storagePlugin({ default: 'uploads', disks: { uploads: { driver: 'local', root: './storage' } } }),
    fastifyPlugin({ routes: [...fileRoutes()] }), // GET /files, GET /files/:id, POST /files/:id/url, DELETE /files/:id
    filesPlugin({
      disk: 'uploads',                                   // a disk name or a Disk instance
      // Optional — uploads are capped at 25 MiB even with no validate at all
      // (DEFAULT_MAX_FILE_SIZE); set your own cap and an allowlist:
      validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
      maxTotalBytes: 1_000_000_000,                      // per-tenant quota (1 GB)
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

## Upload

Uploading is multipart (adapter-specific), so read the bytes in your own handler
and hand the `Buffer` to `FILES.upload` — validation, quota, tenant-scoped
storage, checksum and the `file:uploaded` hook are all done for you. With
Fastify + `@fastify/multipart`:

```ts
import { FILES } from '@basaltkit/files'
import { ctx } from '@basaltkit/core'
import { app } from './app.js'

const files = app.container.get(FILES)
const fastify = app.container.get(FASTIFY)

fastify.post('/files/upload', async (request, reply) => {
  const part = await request.file()                       // @fastify/multipart
  const buffer = await part.toBuffer()
  const record = await files.upload(buffer, {
    name: part.filename,
    contentType: part.mimetype,
    uploadedBy: ctx().user?.id,                            // tenantId comes from ctx().tenant
  })
  return reply.code(201).send(record)                     // FileRecord
})
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
import { defineJob } from '@basaltkit/queue'
import { FILES } from '@basaltkit/files'
import { app } from './app.js'

const files = app.container.get(FILES)

const ScanFile = defineJob<{ tenantId: string; id: string }>({
  name: 'files.scan',
  queue: 'files',
  async handle({ tenantId, id }) {
    const clean = await antivirus.check(/* … */)          // your scanner
    await files.markScanned(id, { clean }, tenantId)       // emits file:scanned
  },
})

// on upload, dispatch the scan job — no coupling to the upload path
app.hooks.on('file:uploaded', ({ file }) =>
  ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))
```

Also available: `download`, `temporaryUrl` (signed), `get`/`list`, `delete`
(emits `file:deleted`). Errors: `FileTooLargeError` (413),
`FileTypeNotAllowedError` (415), `StorageQuotaExceededError` (402).

Storage access runs in the resolved tenant's context, so files stay isolated
even when `upload` is called from a background job.
