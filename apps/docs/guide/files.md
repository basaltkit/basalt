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

Declare the route body with `upload()` from `@basaltkit/http`: a streaming
`multipart/form-data` body that works the same on Fastify, Express and Hono. It is
a normal `route()`, so the whole pipeline (rate limit, tenant and user enrichers,
`auth`/`can` guards) runs **before a single body byte is read**, and an
unauthenticated upload is refused without being received. Each file reaches the
handler as a stream; hand it to `FILES.upload`, which does validation, quota,
tenant-scoped storage, the checksum and the `file:uploaded` hook:

```ts
import { route, upload, HttpError } from '@basaltkit/http'
import { FILES } from '@basaltkit/files'
import { ctx } from '@basaltkit/core'
import { app } from './app.js'

const files = app.container.get(FILES)

export const uploadFile = route({
  method: 'POST',
  url: '/files/upload',
  body: upload({
    maxBytes: 25 * 1024 * 1024,                           // whole request; 413 past it
    maxFiles: 1,                                          // 400 TOO_MANY_FILES past it
    allowedTypes: ['application/pdf', 'image/*'],         // declared type; 415 otherwise
  }),
  meta: { auth: true },
  async handler({ body, reply }) {
    for await (const file of body.files) {
      const record = await files.upload(file.stream, {
        name: file.filename,                              // sanitised basename, never a path
        contentType: file.declaredType,                   // the client's claim, so turn on validate.sniff
        uploadedBy: ctx().user?.id,                       // tenantId comes from ctx().tenant
        metadata: { source: 'web', title: body.fields['title'] }, // text fields sent before the file
      })
      return reply.code(201).send(record)                 // FileRecord
    }
    throw new HttpError(400, 'FILE_REQUIRED', 'Attach a file.')
  },
})
```

The body is parsed while the handler reads it (it is never buffered), with every
limit enforced on the bytes actually received. The [adapters guide](/guide/adapters#uploads)
lists every option and error. You can still pass a `Buffer` to `FILES.upload`.

The returned `FileRecord` is `{ id, tenantId, name, contentType, size, path,
checksum, uploadedBy?, metadata?, scannedAt?, createdAt }`. `path` is the key
**inside the disk** (`files/<uuid>`); the disk adds the tenant prefix on every
operation, so the object really lands at `tenants/<tenantId>/files/<uuid>`.

### Streaming uploads

`upload()` also takes the file as a stream: a Node `Readable`, any
`AsyncIterable<Uint8Array>`, or a web `ReadableStream`. The stream is read once,
and `validate.maxSize` is enforced **while it arrives** — the moment it passes
the cap the source is destroyed/cancelled and `413 FILE_TOO_LARGE` is thrown,
with nothing written. The size and the SHA-256 checksum are computed on the fly,
and `validate.sniff` (below) inspects the first 64 KiB, so a disguised file is
refused before the rest is read.

```ts
// Fastify + @fastify/multipart: part.file is a Readable — no toBuffer()
const part = await request.file()
const record = await files.upload(part.file, { name: part.filename, contentType: part.mimetype, uploadedBy: ctx().user?.id })

// Any web-standard runtime (Hono, a raw PUT body): the body is a ReadableStream
const record = await files.upload(request.body!, { name, contentType: request.headers.get('content-type') ?? 'application/octet-stream' })

// @basaltkit/http's neutral upload() route body yields { stream } per file — on every adapter
const record = await files.upload(file.stream, { name: file.filename, contentType: file.declaredType })
```

::: info Straight to the backend when the driver can stream
On a disk whose driver implements `putStream` — `local`, `s3`, `azure`, `gcs`
(see [Large files](/guide/storage#large-files)) — the bytes go **straight to
storage**: only the 64 KiB sniff window is ever held. Pass `contentLength` when
the client declared one (`Content-Length`); S3 needs a known length to stream
rather than buffer.

```ts
await files.upload(part.file, {
  name: part.filename,
  contentType: part.mimetype,
  contentLength: Number(request.headers['content-length']), // optional hint
})
```

The buffered path — at most `maxSize` in memory, then `disk.put` — remains the
fallback for a driver without `putStream`, an unbounded `validate.maxSize` with
no declared `contentLength`, or a custom `checkQuota` (which is asked to
approve a size the stream does not have yet). The record is identical either
way, and a failed upload leaves neither a record nor a partial object.
:::

::: warning The `contentType` is the client's claim
Without sniffing, `allowedTypes` matches the content type you pass in, which for
a browser upload is whatever the browser said: an HTML page sent as
`application/pdf` passes. Turn on `validate.sniff` (below) — and keep the
antivirus/moderation pass and the signed-URL `attachment` default (see
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

#### Content sniffing (`validate.sniff`)

`validate: { sniff: true }` checks what the bytes **are** instead of trusting
what the client declared. The built-in sniffer reads the file's signature (magic
bytes, no dependency) and recognises PDF, PNG, JPEG, GIF, WebP, TIFF (both byte
orders), ZIP and the Office formats (docx/xlsx/pptx, from the ZIP entry names),
plus the formats that are dangerous when disguised: HTML, SVG and XML text, and
executables (PE/`MZ`, ELF, Mach-O, `#!` scripts). With it on:

- content that contradicts the declared type is refused with
  `FileTypeMismatchError` (`415 FILE_TYPE_MISMATCH`) — an HTML page sent as
  `application/pdf`, an `.exe` sent as `image/jpeg`, an SVG sent as `image/png`,
  a Word file sent as a PDF;
- a declared PDF/PNG/JPEG/GIF/WebP/TIFF/ZIP/Office type whose bytes don't carry
  that signature (a renamed or truncated file) is refused the same way;
- `allowedTypes` judges the **detected** type, the record's `contentType` is the
  detected type, and the client's claim is kept in `metadata.declaredType`;
- content the sniffer has no signature for (plain text, CSV, …) keeps its
  declared type. `application/octet-stream` is accepted as "unknown" and stored
  as whatever the bytes are.

```ts
filesPlugin({
  disk: 'uploads',
  validate: { allowedTypes: ['image/*', 'application/pdf'], sniff: true },
})

// or your own detector (receives the first 64 KiB; return a MIME type or null)
filesPlugin({ disk: 'uploads', validate: { sniff: (head) => myDetector(head) } })
```

Sniffing is **off by default** (it changes what gets stored), but consider
enabling it for any app whose users upload files other users open.
`sniffContentType(bytes)` is exported if you want the same detector elsewhere.

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

### Streaming a download

When you must proxy a large file, `downloadStream()` mirrors `download()` —
same tenant scoping, same quarantine gate — without loading it into memory:

```ts
import { pipeline } from 'node:stream/promises'

const { record, stream } = await files.downloadStream(id)
reply.header('content-type', record.contentType)
reply.header('content-disposition', `attachment; filename="${encodeURIComponent(record.name)}"`)
await pipeline(stream, reply.raw)
```

**Consume the stream or `destroy()` it** — an abandoned one holds a connection
(S3, Azure, GCS) or a file descriptor (local) open. With `requireScan` a
quarantined file throws `423 FILE_NOT_SCANNED` / `403 FILE_INFECTED` before the
stream is ever opened; `{ bypassQuarantine: true }` is for the scanner only. A
driver without `getStream` throws `STORAGE_GET_STREAM_UNSUPPORTED` — use
`download()` there.

### Quarantine until scanned (`requireScan`)

`markScanned(id, { clean: false })` records a failed scan, but on its own does
not stop the file being served. `filesPlugin({ requireScan: true })` makes the
scan a gate: `download()` and `temporaryUrl()` (and so `POST /files/:id/url`)
throw `FileNotScannedError` (`423 FILE_NOT_SCANNED`) until a scan reports the
file clean, and `FileInfectedError` (`403 FILE_INFECTED`) once one reports it
not clean — forever, until a new clean scan. A scan timestamp without a clean
verdict counts as not scanned (fail closed). `GET /files` and `GET /files/:id`
still list the record, with `scannedAt` and `metadata.scan`, so a UI can show
"scanning…" or "blocked". The errors carry their status, so Fastify, Express
and Hono answer identically.

The scanner itself has to read the quarantined bytes: pass
`{ bypassQuarantine: true }` to `download` there — and nowhere that serves users.

```ts
filesPlugin({ disk: 'uploads', requireScan: true })

// in the scan job
const { content } = await files.download(id, tenantId, { bypassQuarantine: true })
await files.markScanned(id, { clean: await antivirus.check(content) }, tenantId)
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
    // explicit tenant: jobs have no ctx; bypassQuarantine because with requireScan the file is not served yet
    const { content } = await files.download(id, tenantId, { bypassQuarantine: true })
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
  await runWithContext({ tenant: { id: file.tenantId } } as never, async () => {
    await disk.image(file.path).resize(256, 256).webp().save(`${file.path}-thumb.webp`)
  })
})
```

Without a processor configured the pipeline's terminal throws
`ImageProcessingUnavailableError` (`STORAGE_IMAGE_UNAVAILABLE`). See the
[image pipeline section of the storage guide](/guide/storage).

## Routes

`fileRoutes()` mounts read/manage endpoints for the **current tenant's** files.
They are built on the neutral `route()` from `@basaltkit/http`, so they serve
identically on Fastify, Express and Hono. Uploading is not among them — you
write that route yourself with the neutral `upload()` body kind shown in
[Uploading](#uploading), so you choose its limits, authorization and naming.

| Route | Body | Returns |
| --- | --- | --- |
| `GET /files` | — | `FileRecord[]` the caller may read |
| `GET /files/:id` | — | one `FileRecord`, or `404 FILE_NOT_FOUND` |
| `POST /files/:id/url` | `{ expiresIn? }` (default `'15m'`, at most `maxUrlTtl`) | `{ url }` — signed, `attachment` |
| `DELETE /files/:id` | — | `204`, or `404 FILE_NOT_FOUND` |

**Owner-only by default.** A user reaches only the files whose `uploadedBy` is
their own `ctx().user.id` — so pass `uploadedBy` in your upload handler (above).
A file the caller may not reach answers `404`, exactly like a missing one, and a
file uploaded without `uploadedBy` is reachable by nobody through these routes.
Choose a different policy explicitly:

```ts
fileRoutes({ shared: true })   // a tenant-wide drive: every member reaches every file

fileRoutes({
  // action: 'read' | 'url' | 'delete'; GET /files keeps the records allowed for 'read'
  authorize: (action, record, user) =>
    record.uploadedBy === user.id || (action !== 'delete' && record.metadata?.['public'] === true),
})
```

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
| `maxTotalBytes` | `number` | unlimited | Built-in per-tenant quota, checked against `store.totalSize()` before each upload. Quota-checked uploads of one tenant run one at a time in the process, and the total is re-checked after the insert (an overrun made by another instance is rolled back) |
| `checkQuota` | `(tenantId, size) => void \| Promise<void>` | — | Custom quota — throw to reject. Wire it to a plan feature in `@basaltkit/subscriptions`. Runs *after* `maxTotalBytes` |
| `requireScan` | `boolean` | `false` | Quarantine: `download`/`temporaryUrl` throw `423 FILE_NOT_SCANNED` until `markScanned` reports the file clean, `403 FILE_INFECTED` after a failed scan. See [Quarantine until scanned](#quarantine-until-scanned-requirescan) |

The `Files` service takes the same options plus `hooks` (the `HookBus`, injected
by the plugin) and `now` (an injectable clock for tests); construct it directly
with `new Files({ disk, ... })` when you want the pipeline without the DI
container.

### `FileValidation` (the `validate` option)

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `maxSize` | `number` (bytes) | `DEFAULT_MAX_FILE_SIZE` = `25 * 1024 * 1024` | Reject bigger payloads with `413`. Set `Number.POSITIVE_INFINITY` to opt out of the cap deliberately |
| `allowedTypes` | `string[]` | any type | Allowlist with `type/*` wildcards (`'image/*'`). Matched against the `contentType` **you pass to `upload`** — or, with `sniff`, against the detected type |
| `sniff` | `boolean \| (bytes: Uint8Array) => string \| null` | `false` | Detect the real type from the magic bytes; refuse mismatches with `415 FILE_TYPE_MISMATCH`, store the detected type, keep the claim in `metadata.declaredType`. See [Content sniffing](#content-sniffing-validate-sniff) |

### `fileRoutes(options?)`

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `authorize` | `(action, record, user) => boolean \| Promise<boolean>` | owner-only | Your per-record policy. `action` is `'read'`, `'url'` or `'delete'`; `user` is `ctx().user`. Replaces the default |
| `shared` | `boolean` | `false` | Every authenticated user of the tenant reaches every file (ignored when `authorize` is set) |
| `maxUrlTtl` | `DurationInput` | `'1h'` | Longest `expiresIn` a client may request from `POST /files/:id/url` |

Every route declares `meta: { auth: true }` — there is no
`auth: false` escape hatch, unlike `billingRoutes`. If authentication genuinely
happens at an outer edge, waive the boot check with the adapter's
`allowUnguardedMeta` instead of removing the meta.

`POST /files/:id/url` accepts `{ expiresIn }` as a duration string (`'30s'`,
`'15m'`, `'1h'`); it defaults to `'15m'`, must be positive and at most
`maxUrlTtl` (a longer or malformed value answers `400`), and always signs with
the `attachment` disposition.

### `Files` service methods

| Method | Purpose |
| --- | --- |
| `upload(content, input)` | The pipeline. `content` is a `Buffer`/`Uint8Array`, a Node `Readable`, an `AsyncIterable<Uint8Array>` or a web `ReadableStream`; `input` is `{ name, contentType, tenantId?, uploadedBy?, metadata?, contentLength? }`. A stream goes straight to the backend when the driver supports `putStream`; `contentLength` is the client's declared size (a hint — the real one is always measured) |
| `get(id, tenantId?)` | `FileRecord \| null` — no throw for a miss |
| `list(tenantId?)` | Every record for the tenant |
| `download(id, tenantId?, { bypassQuarantine? })` | `{ record, content }`; throws `FileNotFoundError`, and with `requireScan` `FileNotScannedError` / `FileInfectedError` unless `bypassQuarantine` (for the scanner only) |
| `downloadStream(id, tenantId?, { bypassQuarantine? })` | `{ record, stream }` — the same contract as `download`, quarantine included, without buffering. The caller must consume or `destroy()` the stream; needs a driver with `getStream` |
| `temporaryUrl(id, expiresIn, tenantId?, { disposition? })` | Signed URL; `attachment` by default. Gated by `requireScan` like `download` |
| `delete(id, tenantId?)` | Removes object + record, emits `file:deleted`; idempotent |
| `markScanned(id, { clean, detail? }, tenantId?)` | Records an out-of-band scan result, emits `file:scanned` |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `FileTooLargeError` | `FILE_TOO_LARGE` | 413 | Payload above `validate.maxSize` — 25 MiB by default, even with no `validate` |
| `FileTypeNotAllowedError` | `FILE_TYPE_NOT_ALLOWED` | 415 | `contentType` (with `sniff`, the detected type) not matched by `validate.allowedTypes` |
| `FileTypeMismatchError` | `FILE_TYPE_MISMATCH` | 415 | `validate.sniff` is on and the bytes contradict the declared type (`error.declared`, `error.detected`) |
| `FileNotScannedError` | `FILE_NOT_SCANNED` | 423 | `requireScan` is on and no scan has reported the file clean yet |
| `FileInfectedError` | `FILE_INFECTED` | 403 | `requireScan` is on and the last scan reported the file not clean |
| `StorageQuotaExceededError` | `FILE_QUOTA_EXCEEDED` | 402 | `maxTotalBytes` would be exceeded by this upload |
| `FileNotFoundError` | `FILE_NOT_FOUND` | 404 | `download` / `markScanned` / `GET /files/:id` for an id that isn't this tenant's |
| `FileTenantRequiredError` | `FILE_TENANT_REQUIRED` | 400 | No `tenantId` argument **and** no `ctx().tenant` — typically a queue worker or CLI |
| `FileTenantMismatchError` | `FILE_TENANT_MISMATCH` | 403 | A `tenantId` argument that differs from `ctx().tenant` — inside a tenant context the argument can only name that tenant, never widen to another |
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
- **`GET /files` returns `[]` for files that exist** — the default policy is
  owner-only: the files were uploaded without `uploadedBy`, or by someone else.
  Pass `uploadedBy: ctx().user.id` on upload, or choose `shared: true` /
  `authorize` on `fileRoutes()`.
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
