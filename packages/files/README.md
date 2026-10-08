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

The quickest route is the opt-in one: `fileRoutes({ upload: { maxBytes, maxFiles?, allowedTypes? } })`
mounts `POST /files`, a streamed `multipart/form-data` upload that goes straight into
storage with the same tenant scoping, validation and quota rules as any other upload. It
is off by default — the limits are yours to choose, so the route only exists once you
state them.

For your own route, declare the neutral `upload()` body from `@basaltkit/http` (it works
identically on Fastify, Express and Hono) and hand each file's stream to the service:

```ts
import { route, upload } from '@basaltkit/http'

route({
  method: 'POST',
  url: '/documents',
  body: upload({ maxBytes: 20 * 1024 * 1024, maxFiles: 1, allowedTypes: ['application/pdf'] }),
  meta: { auth: true },
  async handler({ body }) {
    for await (const file of body.files) {
      await files.upload(file.stream, {
        name: file.filename,
        contentType: file.declaredType,
        uploadedBy: ctx().user?.id,
        // The part's own Content-Length, when the client sent one — usually absent
        // (no browser sends it), and never derived from the request's Content-Length,
        // which covers every part plus the multipart framing.
        ...(file.declaredLength !== undefined ? { contentLength: file.declaredLength } : {}),
      })
      // tenantId comes from the request context (tenancy)
    }
  },
})
```

`upload()` also takes a **stream** — a Node `Readable`, an `AsyncIterable<Uint8Array>` or a web `ReadableStream` — enforcing `maxSize` while it arrives (the source is cancelled past the cap, nothing is written), and computing the size, the SHA-256 and the sniffed type on the fly:

```ts
const part = await req.file()
await files.upload(part.file, { name: part.filename, contentType: part.mimetype }) // part.file is a Readable
await files.upload(request.body!, { name, contentType })                            // web ReadableStream (Hono, raw PUT)
await files.upload(file.stream, { name: file.filename, contentType: file.contentType }) // @basaltkit/http upload() body
```

On a disk whose driver can stream (`local`, `s3`, `azure`, `gcs` — see
`disk.supports('putStream')`), the bytes go **straight to the backend**: this
module holds only the 64 KiB sniff window, and the driver holds what its own
upload protocol needs — nothing on `local`, one request body on S3 with a
`contentLength`, the SDK's part/block buffers otherwise (S3 multipart:
`partSizeBytes × queueSize`, 20 MiB by default; see each driver's README). None
of them buffers up to `maxSize`. Pass `contentLength` when the client declared
one (`Content-Length`) — S3 then streams it into a single `PutObject`.

`contentLength` is a declaration, and it is held to it: a value that is not a
non-negative integer is refused before the body is read (400
`STORAGE_CONTENT_LENGTH_INVALID`), one past `maxSize` with 413
`FILE_TOO_LARGE`, and a body that carries more or fewer bytes fails with 400
`STORAGE_CONTENT_LENGTH_MISMATCH` — before its end reaches the backend, so no
object is committed and no record is written. The record's `size` is always the
measured one.

The buffered path (at most `maxSize` in memory, then `disk.put`) is the
fallback, used for a driver with no `putStream`, an unbounded
`validate.maxSize` with no declared `contentLength`, or a custom `checkQuota`
(which is asked to approve a size the stream does not yet have). Either way the
record is identical, and a failed upload leaves neither a record nor a partial
object.

### Streaming a download

`files.downloadStream(id, tenantId?, { bypassQuarantine? })` mirrors
`download()` — same tenant scoping, same quarantine gate — without loading the
file into memory:

```ts
import { route, stream } from '@basaltkit/http'

route({
  method: 'GET',
  url: '/documents/:id',
  meta: { auth: true },
  async handler({ params }) {
    const { record, stream: body } = await files.downloadStream(params.id)
    return stream(body, { contentType: record.contentType, contentLength: record.size, filename: record.name })
  },
})
```

`stream()` is the neutral streaming response: every adapter sends it without buffering,
destroys the source when the client disconnects, and answers `HEAD` with the headers
alone. `fileRoutes()` uses exactly this for `GET /files/:id/content`.

**Consume the stream or `destroy()` it** — an abandoned one holds a connection
(S3/Azure/GCS) or a file descriptor (local) open; returning it through `stream()` hands
that responsibility to the adapter. `files.canStreamDownloads()` says whether the disk's
driver can stream at all; one that cannot throws `STORAGE_GET_STREAM_UNSUPPORTED`, so
fall back to `download()` there (which is what `fileRoutes()` does).

## Checking the real type (`validate.sniff`)

By default `allowedTypes` trusts the client-declared `contentType` — an HTML page sent as `application/pdf` passes. `validate: { sniff: true }` reads the magic bytes instead (built-in table, no dependency: PDF, PNG, JPEG, GIF, WebP, TIFF, ZIP, docx/xlsx/pptx, and HTML/SVG/XML text and PE/ELF/Mach-O executables to catch disguises). A mismatch is `415 FILE_TYPE_MISMATCH`; the allowlist judges the detected type; the record stores the detected type and keeps the claim in `metadata.declaredType`. An upload declared `application/octet-stream` is promoted to the detected type only when that is inert (PDF, raster images, audio, video, ZIP/Office — `isInertType`); HTML, SVG, XML, scripts and executables sent as octet-stream are refused, never relabelled — storing one takes declaring it, and the allowlist judges that declaration. Pass a function `(bytes) => string | null` for your own detector. Off by default — **consider enabling it** whenever users upload files other users open.

## Quarantine until scanned (`requireScan`)

With `filesPlugin({ requireScan: true })`, `download()` / `downloadStream()` / `temporaryUrl()` (and `GET /files/:id/content`, `POST /files/:id/url`) throw `423 FILE_NOT_SCANNED` until `markScanned` reports the file clean, and `403 FILE_INFECTED` after a failed scan. Listing still shows every record with its scan state. The scanner reads the quarantined bytes with `files.download(id, tenantId, { bypassQuarantine: true })`.

The other operations have ready-made routes via `fileRoutes()`:

| Route | Description |
|---|---|
| `GET /files` | Lists the current tenant's files (public projection, below). |
| `GET /files/:id` | A file's metadata (public projection, below). |
| `GET /files/:id/content` | The bytes, **streamed** (`Content-Disposition: attachment`). Authorized with the `'download'` action; with `requireScan` it answers 423/403 before a single byte. `fileRoutes({ download: false })` leaves it out. |
| `POST /files` | **Opt-in** (`fileRoutes({ upload: { maxBytes, maxFiles?, allowedTypes? } })`): a streamed multipart upload into storage, `uploadedBy` set to the caller. Returns `201` with the created files, in the public projection. |
| `POST /files/:id/url` `{ expiresIn? }` | Temporary signed URL. |
| `DELETE /files/:id` | Deletes bytes + metadata. |

**Owner-only by default:** a user reaches only files whose `uploadedBy` is their own id; anything else answers 404. Choose another policy explicitly with `fileRoutes({ shared: true })` (tenant-wide drive) or `fileRoutes({ authorize: (action, record, user) => boolean })` (`action` is `'read' | 'download' | 'url' | 'delete'`; `'read'` is the record, `'download'` the bytes). `expiresIn` must be positive and at most `maxUrlTtl` (default `'1h'`), otherwise 400; when omitted it defaults to 15 minutes, lowered to `maxUrlTtl` if that is shorter.

**Route meta.** Every route requires a logged-in user. `fileRoutes({ meta: { can: 'files:read' } })` merges extra route metadata — a guard, a rate limit, OpenAPI tags — into every route; `auth: true` is applied on top and cannot be switched off.

**Public projection.** The routes never answer with the raw `FileRecord`. By
default every record goes through `toPublicFile(record)`:
`{ id, name, contentType, size, createdAt, scannedAt?, scan?: { clean }, metadata? }`.
Kept server-side: `path` (the storage key — your bucket layout), `checksum`,
`tenantId`, `uploadedBy` (a user id — someone else's, on a shared drive) and the
scanner's `detail` (engine output: signature names, versions, temp paths); the
verdict stays as `scan.clean`, and `metadata` loses only its internal `scan`
entry. Choose your own shape with `present`, which runs after authorization,
as the caller:

```ts
fileRoutes({
  shared: true,
  // "uploaded by" matters on a shared drive — add it back on purpose.
  present: (file, user) => ({ ...toPublicFile(file), mine: file.uploadedBy === user.id }),
})
```

> **Upgrading from 5.x:** these routes used to return the whole record. A
> client that read `path`, `checksum`, `uploadedBy`, `tenantId` or
> `metadata.scan.detail` from them must now get it from a `present` you write
> (or from `files.get(id)` server-side). `files.get()` / `files.list()` and
> the hooks are unchanged — they still hand you the full record.

`POST /files` has no per-record `authorize` decision to make — there is no record yet — so
it accepts any authenticated caller and applies `Files`' own rules: the tenant from the
request context, `validate` (size/type/sniff), and the quota. Bound it at the edge with
`maxBytes`/`maxFiles`/`allowedTypes`, and rate-limit it like any other write route.

## Post-processing with hooks

The typical pattern: on `file:uploaded`, dispatch a job (with `@basaltkit/queue`) that scans/processes the file and then calls `markScanned`:

```ts
hooks.on('file:uploaded', ({ file }) => ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))

// in the job, after scanning:
await files.markScanned(id, { clean: true }, tenantId) // emits file:scanned
// with requireScan, the scanner reads the bytes via download(id, tenantId, { bypassQuarantine: true })
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
| `requireScan` | `boolean` | `false` | Quarantine: `download`/`temporaryUrl` throw `423 FILE_NOT_SCANNED` until a scan reports the file clean, `403 FILE_INFECTED` after a failed scan. |
| `store` | `FileStore` | `MemoryFileStore` | Where file metadata lives. In-memory means records vanish on restart while the bytes stay in storage — implement `FileStore` over your database in production. |

`FileValidation`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `maxSize` | `number` | `DEFAULT_MAX_FILE_SIZE` = **25 MiB** (`26214400`) | Per-file byte cap. Secure by default: uploads are capped even when you configure nothing. Raise it, or pass `Infinity` to disable. |
| `allowedTypes` | `string[]` | — (anything) | Content-type allowlist. Supports trailing wildcards: `'image/*'` matches `image/png`. With `sniff`, matched against the detected type. |
| `sniff` | `boolean \| (bytes: Uint8Array) => string \| null` | `false` | Detect the real type from the first 64 KiB; refuse mismatches (`415 FILE_TYPE_MISMATCH`); store the detected type, keep the declared one in `metadata.declaredType`. |

`DEFAULT_MAX_FILE_SIZE` is exported, so you can express a limit relative to it.

> The cap applies to the buffer or stream you hand to `upload()` (a stream is cut off as soon as it passes it). Your HTTP adapter's own
> body limit still applies first, and `@basaltkit/storage` itself caps nothing
> unless you pass `maxBytes` per `put()`.

### `class Files`

| Method | Description |
|---|---|
| `upload(content, input)` | Validates, enforces quota, stores, records metadata, emits `file:uploaded`. `content`: `Buffer`/`Uint8Array`, Node `Readable`, `AsyncIterable<Uint8Array>` or web `ReadableStream`. A stream goes straight to the backend when the driver supports `putStream`. `input.contentLength` (optional) is the client-declared size: validated up front and verified against the bytes (400 `STORAGE_CONTENT_LENGTH_INVALID` / `_MISMATCH`, 413 past `maxSize`); the record's size is the measured one. |
| `download(id, tenantId?, { bypassQuarantine? })` | `{ record, content }`. Gated by `requireScan`; `bypassQuarantine` is for the scanner only. |
| `downloadStream(id, tenantId?, { bypassQuarantine? })` | `{ record, stream }` — the same contract as `download`, quarantine included, without buffering. The caller must consume or `destroy()` the stream. Needs a driver with `getStream`. |
| `canStreamDownloads()` | `true` when this disk's driver implements `getStream` (local, S3, Azure, GCS), so callers can take the streaming path and buffer where it does not exist instead of catching `STORAGE_GET_STREAM_UNSUPPORTED`. |
| `temporaryUrl(id, expiresIn, tenantId?, options?)` | Signed URL. Served `Content-Disposition: attachment` by default; pass `{ disposition: 'inline' }` only when top-level rendering is deliberate — an uploaded HTML/SVG file served inline is stored XSS on the storage origin. Embedded `<img>`/`<video>` uses render regardless. |
| `get(id, tenantId?)` · `list(tenantId?)` | Metadata. |
| `delete(id, tenantId?)` | Deletes bytes + metadata; emits `file:deleted`. |
| `markScanned(id, result, tenantId?)` | Marks as scanned; emits `file:scanned`. |
| `sniffContentType(bytes)` (export) | The built-in signature sniffer: MIME type or `null`. |

Without an explicit `tenantId`, it uses `ctx().tenant.id`. Inside a tenant context an explicit `tenantId` must equal it, otherwise `FileTenantMismatchError` (403) — the argument can never widen a call to another tenant. With no tenant resolvable it throws `FileTenantRequiredError` **only when `@basaltkit/tenancy` is registered** — an app without tenancy has no tenant dimension to cross, and its records are keyed by `SINGLE_TENANT_SCOPE` (`'@single'`, a sentinel outside the tenant-id grammar; a tenant carrying it is refused with `FileTenantReservedError`). In such an app pass a `storagePlugin` disk name, or a `Disk` built with `scope: null` — a hand-built disk on the default scope refuses to run without a tenant.

> **Upgrading from 4.x (single-tenant data):** the key used to be `'default'`, a valid tenant id — a tenant named `default` could read and orphan the single-tenant files. Re-key persisted rows once: `UPDATE files SET "tenantId" = '@single' WHERE "tenantId" = 'default'` (and `file_versions` too with `@basaltkit/files-versions`). Skip it if `default` was ever a real tenant in that database. Storage access runs in the resolved tenant's context, so files stay isolated even from a background job.

### Failure modes

| Error | Code | HTTP | When |
|---|---|---|---|
| `FileTooLargeError` | `FILE_TOO_LARGE` | 413 | The buffer exceeds `validate.maxSize` — 25 MiB when you configured nothing. |
| `FileTypeNotAllowedError` | `FILE_TYPE_NOT_ALLOWED` | 415 | `contentType` (with `sniff`, the detected type) doesn't match `validate.allowedTypes`. |
| `FileTypeMismatchError` | `FILE_TYPE_MISMATCH` | 415 | `validate.sniff` is on and the bytes contradict the declared type. |
| `FileNotScannedError` | `FILE_NOT_SCANNED` | 423 | `requireScan` is on and no scan has reported the file clean yet. |
| `FileInfectedError` | `FILE_INFECTED` | 403 | `requireScan` is on and the last scan reported the file not clean. |
| `StorageQuotaExceededError` | `FILE_QUOTA_EXCEEDED` | 402 | The tenant's total stored bytes plus this upload would pass `maxTotalBytes`. |
| `FileNotFoundError` | `FILE_NOT_FOUND` | 404 | `download` / `temporaryUrl` / `markScanned` for an id absent from this tenant's metadata store. |
| `FileTenantRequiredError` | `FILE_TENANT_REQUIRED` | 400 | No `tenantId` argument and no `ctx().tenant` — every operation is tenant-scoped and fails closed rather than querying unscoped. |
| `FileTenantMismatchError` | `FILE_TENANT_MISMATCH` | 403 | An explicit `tenantId` differs from the context tenant. |
| `FileTenantReservedError` | `FILE_TENANT_RESERVED` | 400 | The tenant id equals `SINGLE_TENANT_SCOPE`, the single-tenant store key. |
| `StorageContentLengthInvalidError` | `STORAGE_CONTENT_LENGTH_INVALID` | 400 | `input.contentLength` is negative, fractional, not finite or past `MAX_SAFE_INTEGER`. Nothing is read. |
| `StorageContentLengthMismatchError` | `STORAGE_CONTENT_LENGTH_MISMATCH` | 400 | The body carried more or fewer bytes than `input.contentLength`. No object is committed, no record written. |

All extend `BasaltError` and declare a `status`, so the adapters map them to the
HTTP code above with the real error `code` in the body. Errors thrown by the
underlying disk (`STORAGE_*`) keep their status when they declare one (the
two `STORAGE_CONTENT_LENGTH_*` above, `STORAGE_STREAM_LENGTH_REQUIRED`, …);
the rest surface as 500 `INTERNAL_ERROR`.

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
