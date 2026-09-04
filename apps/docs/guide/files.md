# File uploads

`@basaltkit/files` is the upload pipeline that sits on top of
[`@basaltkit/storage`](/guide/storage): it validates content type and size,
enforces a per-tenant quota, writes the bytes tenant-scoped, records the
metadata, and emits hooks so scanning and thumbnailing happen out of band. It is
decoupled from the transport — multipart parsing stays in your handler — and
from the backend, because every byte goes through a storage `Disk`.

[[toc]]

## Mental model

A file is **two things that must not be confused**:

| Piece | Lives in | Owned by |
| --- | --- | --- |
| The **bytes** | a storage `Disk` (local, S3, GCS, Azure) at `files/<uuid>` | `@basaltkit/storage` |
| The **record** (name, size, content type, SHA-256, uploader, scan result) | a `FileStore` | `@basaltkit/files` |

`Files.upload()` is the only thing that writes both, in this order: validate
size → validate content type → check quota → write bytes → save record → emit
`file:uploaded`. If validation or the quota rejects, **nothing is written** —
neither bytes nor record.

In a **multi-tenant** app every operation is tenant-scoped. The tenant comes
from the explicit `tenantId` argument, or from `ctx().tenant.id`, and there is no
third option: with neither, the call throws `FileTenantRequiredError`
(`400 FILE_TENANT_REQUIRED`) rather than falling back to a global namespace.
Storage access is then wrapped in that tenant's context, so the disk's default
`tenants/<id>/` prefix applies even when `upload` runs from a background job
with no ambient request.

In a **single-tenant** app — no `tenancyPlugin` — there is no tenant dimension,
so nothing to fail closed about: `upload`/`list`/`get`/`download`/`delete` work
with no `tenantId`, records are filed under one internal `'default'` scope, and
storage paths stay unprefixed, exactly as if you used `@basaltkit/storage`
directly. See [Beyond SaaS](/guide/beyond-saas).

## Quickstart

`filesPlugin` needs a disk. Register `storagePlugin` first, point `filesPlugin`
at a disk by name (or pass a `Disk` instance), and mount the read/manage routes
through your adapter:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { authPlugin, MemoryUserSource } from '@basaltkit/auth'
import { storagePlugin } from '@basaltkit/storage'
import { FILES, filesPlugin, fileRoutes } from '@basaltkit/files'

export const app = await createApp({
  plugins: [
    // ... your tenancy plugin, which sets ctx().tenant ...
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    storagePlugin({ default: 'uploads', disks: { uploads: { driver: 'local', root: './storage' } } }),
    filesPlugin({
      disk: 'uploads',                                   // a disk name or a Disk instance
      // Uploads are capped at 25 MiB (DEFAULT_MAX_FILE_SIZE) even with no
      // `validate` at all; set your own cap and an allowlist:
      validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
      maxTotalBytes: 1_000_000_000,                      // per-tenant quota (1 GB)
    }),
    fastifyPlugin({ routes: [...fileRoutes()] }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

`fileRoutes()` all declare `meta: { auth: true }`, so `authPlugin` must be
registered — otherwise the adapter refuses to boot with `UnguardedRouteMetaError`
(`HTTP_UNGUARDED_ROUTE_META`) instead of serving your files unauthenticated.
See the [adapters guide](/guide/adapters).

## Uploading

Multipart parsing is adapter-specific, so read the bytes in your own handler and
hand the `Buffer` to `FILES.upload`. Validation, quota, tenant-scoped storage,
the checksum and the `file:uploaded` hook are all done for you. With Fastify +
`@fastify/multipart`:

```ts
import { FILES } from '@basaltkit/files'
import { FASTIFY } from '@basaltkit/fastify'
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
    uploadedBy: ctx().user?.id,                           // tenantId comes from ctx().tenant
    metadata: { source: 'web' },                          // anything you want on the record
  })
  return reply.code(201).send(record)                     // FileRecord
})
```

The returned `FileRecord` is `{ id, tenantId, name, contentType, size, path,
checksum, uploadedBy?, metadata?, scannedAt?, createdAt }`. `path` is the key
**inside the disk** (`files/<uuid>`); the disk adds the tenant prefix on every
operation, so the object really lands at `tenants/<tenantId>/files/<uuid>`.

::: warning The `contentType` is the client's claim
`allowedTypes` matches the content type you pass in, which for a browser upload
is whatever the browser said. It stops honest mistakes, not attackers. Treat
sniffing the magic bytes, and the antivirus/moderation pass below, as the real
control — and keep the signed-URL `attachment` default (see
[Storage](/guide/storage)) so a mislabelled HTML or SVG upload can't render on
the storage origin.
:::

### Size and type limits

`validate.maxSize` defaults to `DEFAULT_MAX_FILE_SIZE` — **25 MiB** — and is
applied even when you pass no `validate` at all. Anything larger throws
`FileTooLargeError` (`413 FILE_TOO_LARGE`) before a byte is written:

```ts
import { DEFAULT_MAX_FILE_SIZE } from '@basaltkit/files'

filesPlugin({ disk: 'uploads', validate: { maxSize: 50 * 1024 * 1024 } })  // raise it
filesPlugin({ disk: 'uploads', validate: { maxSize: Number.POSITIVE_INFINITY } }) // opt out
```

`allowedTypes` is an allowlist with a `type/*` wildcard: `['image/*',
'application/pdf']` accepts `image/png` and `application/pdf` and rejects
everything else with `FileTypeNotAllowedError` (`415 FILE_TYPE_NOT_ALLOWED`).
With no `allowedTypes`, every content type is accepted.

The pipeline's cap is separate from the storage facade's own per-`put`
`maxBytes` / `allowedContentTypes` — see the
[storage options reference](/guide/storage). You do not need both; `filesPlugin`
is the right place for upload policy.

## Quotas

`maxTotalBytes` is the built-in per-tenant cap. Before each upload the store's
`totalSize(tenantId)` is summed against the incoming size; over the line throws
`StorageQuotaExceededError` (`402 FILE_QUOTA_EXCEEDED`).

To tie storage to a plan instead, wire `checkQuota` — an async hook that throws
to reject — into [`@basaltkit/subscriptions`](/guide/billing):

```ts
filesPlugin({
  disk: 'uploads',
  checkQuota: (tenantId, size) =>
    subscriptions.features(tenantId).consume('storage_bytes', size),
})
```

Both run when both are set: `maxTotalBytes` first, then `checkQuota`. Note that
`consume()` **records** the consumption, so a `checkQuota` built on it must be
balanced by releasing the units when a file is deleted (listen for
`file:deleted`) — otherwise a tenant's plan quota only ever goes down.

## Serving and downloading

Three ways to get bytes back to a client, in order of preference:

```ts
// 1. A signed URL straight to the object — no bytes through your app.
const url = await files.temporaryUrl(id, '15m')

// 2. The bytes, for small files or when you must proxy.
const { record, content } = await files.download(id)

// 3. Metadata only.
const record = await files.get(id)          // FileRecord | null
const all = await files.list()              // FileRecord[] for the tenant
```

`temporaryUrl` inherits the storage default: **`Content-Disposition:
attachment`**, so an uploaded HTML or SVG can never render top-level on the
storage origin. Pass `{ disposition: 'inline' }` (fourth argument) when
in-browser rendering is deliberate — embedded `<img>`/`<video>` uses render
either way. The full rationale is in [Storage](/guide/storage).

```ts
await files.temporaryUrl(id, '15m', undefined, { disposition: 'inline' })
```

Signed URLs need a driver that supports them: `s3`, GCS and Azure do, the
`local` driver throws `TemporaryUrlUnsupportedError`
(`STORAGE_TEMPORARY_URL_UNSUPPORTED`). In local development, proxy through
`files.download()` instead.

`files.delete(id)` removes the object and the record and emits `file:deleted`.
It is idempotent: deleting an unknown id is a silent no-op, never a 404.

## Post-processing hooks

`file:uploaded` fires after the record is saved, so the upload response never
waits on your scanner. The typical pattern is to dispatch a queue job and record
the outcome with `markScanned`, which stamps `scannedAt`, merges the result
into `metadata.scan` and emits `file:scanned`:

```ts
import { defineJob } from '@basaltkit/queue'
import { FILES } from '@basaltkit/files'
import { app } from './app.js'

const files = app.container.get(FILES)

const ScanFile = defineJob<{ tenantId: string; id: string }>({
  name: 'files.scan',
  queue: 'files',
  async handle({ tenantId, id }) {
    const { content } = await files.download(id, tenantId)  // explicit tenant: jobs have no ctx
    const clean = await antivirus.check(content)            // your scanner
    await files.markScanned(id, { clean }, tenantId)        // emits file:scanned
  },
})

// on upload, dispatch the scan job — no coupling to the upload path
app.hooks.on('file:uploaded', ({ file }) =>
  ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))
```

::: tip Pass `tenantId` explicitly in jobs
Inside a request the tenant is read from `ctx()`. A queue worker runs outside
any request, so pass the `tenantId` you put on the job payload — every `Files`
method takes it as an optional argument for exactly this reason. Without it you
get `400 FILE_TENANT_REQUIRED`, not another tenant's file.
:::

Derivatives (thumbnails, transcodes) follow the same shape, using the storage
image pipeline. It needs an `imageProcessor` — `SharpImageProcessor` from
`@basaltkit/image-sharp` — on `storagePlugin`, and the disk operations must run
in the file's tenant context:

```ts
import { runWithContext } from '@basaltkit/core'
import { STORAGE } from '@basaltkit/storage'

app.hooks.on('file:uploaded', async ({ file }) => {
  if (!file.contentType.startsWith('image/')) return
  const disk = app.container.get(STORAGE).disk('uploads')
  await runWithContext({ tenant: { id: file.tenantId } } as never, () =>
    disk.image(file.path).resize(256, 256).webp().save(`${file.path}-thumb.webp`))
})
```

Without a processor configured the pipeline's terminal throws
`ImageProcessingUnavailableError` (`STORAGE_IMAGE_UNAVAILABLE`). See the
[image pipeline section of the storage guide](/guide/storage).

## Routes

`fileRoutes()` mounts read/manage endpoints for the **current tenant's** files.
They are built on the neutral `route()` from `@basaltkit/http`, so they serve
identically on Fastify, Express and Hono. Uploading is not among them —
multipart is transport-specific, so you write that handler (above).

| Route | Body | Returns |
| --- | --- | --- |
| `GET /files` | — | `FileRecord[]` for the tenant |
| `GET /files/:id` | — | one `FileRecord`, or `404 FILE_NOT_FOUND` |
| `POST /files/:id/url` | `{ expiresIn? }` (default `'15m'`) | `{ url }` — signed, `attachment` |
| `DELETE /files/:id` | — | `204`, idempotent |

::: danger Authentication is not tenant authorization
Every route declares `meta: { auth: true }`, which proves *who* is calling. It
does **not** prove the caller belongs to the tenant the request resolved to —
the tenant comes from a header or a `Host`, both client-controlled. Register
[`tenantMembershipPlugin()`](/guide/teams) so a valid user of tenant A sending
tenant B's identifier is stopped with `403 TEAM_NOT_A_MEMBER` before any file
code runs. Without it, `GET /files` lists whichever tenant the request claims.
:::

## Storing metadata durably

The default `FileStore` is `MemoryFileStore` — per process, gone on restart,
and the bytes then outlive the records that point at them. There is **no
`files-sqlite` / `files-prisma` package**: file metadata belongs in your own
schema next to the domain rows that reference it. The contract is six methods:

```ts
import type { FileStore, FileRecord, FilePatch } from '@basaltkit/files'

class PrismaFileStore implements FileStore {
  constructor(private readonly prisma: PrismaClient) {}
  async create(record: FileRecord) { await this.prisma.file.create({ data: record }) }
  async find(tenantId: string, id: string) { return this.prisma.file.findFirst({ where: { tenantId, id } }) }
  async list(tenantId: string) { return this.prisma.file.findMany({ where: { tenantId } }) }
  async update(tenantId: string, id: string, patch: FilePatch) {
    return this.prisma.file.update({ where: { id }, data: patch })
  }
  async delete(tenantId: string, id: string) { await this.prisma.file.deleteMany({ where: { tenantId, id } }) }
  async totalSize(tenantId: string) {
    const { _sum } = await this.prisma.file.aggregate({ _sum: { size: true }, where: { tenantId } })
    return _sum.size ?? 0
  }
}

filesPlugin({ disk: 'uploads', store: new PrismaFileStore(prisma) })
```

Every method is passed the `tenantId` — keep it in the `where` clause of all of
them. `totalSize` is the quota's hot path, so index `(tenantId)`. See
[Persistence](/guide/persistence).

## Options reference

### `filesPlugin(options)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `disk` | `Disk \| string` | — (required) | The storage disk, by instance or by the name declared in `storagePlugin({ disks })`. An unknown name throws `UnknownDiskError` when `FILES` is first resolved |
| `store` | `FileStore` | `MemoryFileStore` | Where metadata lives — implement it over your database in production, or the records vanish on restart |
| `validate` | `FileValidation` | `{ maxSize: 25 MiB }` | Upload policy (below). Passing `validate` **merges** with the default cap; it does not remove it |
| `maxTotalBytes` | `number` | unlimited | Built-in per-tenant quota, checked against `store.totalSize()` before each upload |
| `checkQuota` | `(tenantId, size) => void \| Promise<void>` | — | Custom quota — throw to reject. Wire it to a plan feature in `@basaltkit/subscriptions`. Runs *after* `maxTotalBytes` |

The `Files` service takes the same options plus `hooks` (the `HookBus`, injected
by the plugin) and `now` (an injectable clock for tests); construct it directly
with `new Files({ disk, ... })` when you want the pipeline without the DI
container.

### `FileValidation` (the `validate` option)

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `maxSize` | `number` (bytes) | `DEFAULT_MAX_FILE_SIZE` = `25 * 1024 * 1024` | Reject bigger payloads with `413`. Set `Number.POSITIVE_INFINITY` to opt out of the cap deliberately |
| `allowedTypes` | `string[]` | any type | Allowlist with `type/*` wildcards (`'image/*'`). Matched against the `contentType` **you pass to `upload`** |

### `fileRoutes()`

Takes no options. Every route declares `meta: { auth: true }` — there is no
`auth: false` escape hatch, unlike `billingRoutes`. If authentication genuinely
happens at an outer edge, waive the boot check with the adapter's
`allowUnguardedMeta` instead of removing the meta.

`POST /files/:id/url` accepts `{ expiresIn }` as a duration string (`'30s'`,
`'15m'`, `'2h'`, `'7d'`) or milliseconds; it defaults to `'15m'` and always
signs with the `attachment` disposition.

### `Files` service methods

| Method | Purpose |
| --- | --- |
| `upload(content, input)` | The pipeline. `input` is `{ name, contentType, tenantId?, uploadedBy?, metadata? }` |
| `get(id, tenantId?)` | `FileRecord \| null` — no throw for a miss |
| `list(tenantId?)` | Every record for the tenant |
| `download(id, tenantId?)` | `{ record, content }`; throws `FileNotFoundError` |
| `temporaryUrl(id, expiresIn, tenantId?, { disposition? })` | Signed URL; `attachment` by default |
| `delete(id, tenantId?)` | Removes object + record, emits `file:deleted`; idempotent |
| `markScanned(id, { clean, detail? }, tenantId?)` | Records an out-of-band scan result, emits `file:scanned` |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `FileTooLargeError` | `FILE_TOO_LARGE` | 413 | Payload above `validate.maxSize` — 25 MiB by default, even with no `validate` |
| `FileTypeNotAllowedError` | `FILE_TYPE_NOT_ALLOWED` | 415 | `contentType` not matched by `validate.allowedTypes` |
| `StorageQuotaExceededError` | `FILE_QUOTA_EXCEEDED` | 402 | `maxTotalBytes` would be exceeded by this upload |
| `FileNotFoundError` | `FILE_NOT_FOUND` | 404 | `download` / `markScanned` / `GET /files/:id` for an id that isn't this tenant's |
| `FileTenantRequiredError` | `FILE_TENANT_REQUIRED` | 400 | No `tenantId` argument **and** no `ctx().tenant` — typically a queue worker or CLI |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | — | `disk: 'name'` doesn't match any disk in `storagePlugin({ disks })` |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | — | `temporaryUrl` on the `local` driver |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | — | The record exists but the object doesn't — bytes deleted out of band, or the disk/`scope` changed under the records |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | — | `disk.image(…)` with no `imageProcessor` on `storagePlugin` |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | `fileRoutes()` registered without `authPlugin` — every route declares `meta.auth` |

- **`400 FILE_TENANT_REQUIRED` from a queue worker or a cron job** — there is no
  ambient tenant outside a request. Put the `tenantId` on the job payload and
  pass it to every `Files` call.
- **`GET /files` returns another tenant's files** — the tenant identifier is
  client-supplied and `meta.auth` doesn't check membership. Register
  [`tenantMembershipPlugin()`](/guide/teams).
- **Files vanish after a redeploy, but the bytes are still in the bucket** —
  you are still on `MemoryFileStore`. Implement `FileStore` over your database.
- **`STORAGE_TEMPORARY_URL_UNSUPPORTED` only in development** — the `local`
  driver can't sign URLs. Serve through `files.download()` in dev, or run MinIO
  behind an `s3` disk so both environments behave the same.
- **A signed URL downloads instead of previewing** — that is the fail-closed
  default. Pass `{ disposition: 'inline' }` per URL when top-level rendering is
  deliberate.
- **The plan quota never recovers after deletes** — a `checkQuota` built on
  `features().consume()` only increments. Release the units on `file:deleted`.

## Events

| Hook | Payload |
| --- | --- |
| `file:uploaded` | `{ file }` — dispatch the scan/thumbnail job here |
| `file:deleted` | `{ tenantId, id }` |
| `file:scanned` | `{ file }` — emitted by `markScanned` |

## See also

- [Storage](/guide/storage) — disks, drivers, signed URLs, the image pipeline.
- [Teams](/guide/teams) — `tenantMembershipPlugin()`, the guard that makes the
  tenant-scoped routes above actually tenant-safe.
- [Queues & jobs](/guide/queues) — running scans and transcodes off the request.
- [Multi-tenant SaaS cookbook](/cookbook/multi-tenant-saas) — the whole stack in
  one app.
