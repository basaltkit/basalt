# Storage

`@basaltkit/storage` gives every backend one API — a **Disk** with
`put`/`get`/`exists`/`delete`/`list` and signed `temporaryUrl`s — and scopes
every path by tenant automatically. The local-filesystem driver ships in the
core; every cloud backend — S3, Google Cloud Storage, Azure Blob — is a drop-in
driver package, so you install only the SDK you actually use.

[[toc]]

## Setup

`storagePlugin` registers a `Storage` under the `STORAGE` token. Declare one or
more named disks; start with the `local` driver, which only needs a folder:

```ts
import { createApp } from '@basaltkit/core'
import { storagePlugin, STORAGE } from '@basaltkit/storage'

const app = await createApp({
  plugins: [
    storagePlugin({
      default: 'uploads',
      disks: {
        uploads: { driver: 'local', root: './storage' },
      },
    }),
  ],
}).boot()

const disk = app.container.get(STORAGE).disk()   // the default disk ('uploads')
await disk.put('avatars/1.png', buffer, { contentType: 'image/png' })
```

Each `Disk` prefixes paths with `tenants/<id>` from `ctx().tenant` — so the same
code keeps every tenant's files isolated. Pass `scope: null` on a disk to turn
that off.

**Fails closed without a tenant.** When `@basaltkit/tenancy` is registered, a
disk on the default scope refuses to run with no tenant in context and throws
`StorageTenantRequiredError` (`400 STORAGE_TENANT_REQUIRED`). Without that, a
request that simply omitted its tenant would resolve the caller's key against
the bucket root, where `tenants/<other-tenant>/…` is reachable by name. A
deliberately central disk (backups, platform branding) says so explicitly:
`scope: null`, or `onMissingScope: 'root'` for a disk that is tenant-scoped
inside a tenant and central outside one. Apps without tenancy are unaffected.

A tenant id that is not a single safe path segment (`..`, `a/b`, control
characters) is refused with `StorageInvalidScopeError` rather than joined into
the path.

## put / get / exists / delete / list

`put` accepts a string or `Buffer` and creates intermediate folders; `get`
always returns raw bytes as a `Buffer`:

```ts
await disk.put('docs/read-me.txt', 'hello')
await disk.put('img/pixel.bin', Buffer.from([1, 2, 3]))
await disk.put('report.pdf', pdfBuffer, { contentType: 'application/pdf' }) // S3 sets Content-Type

const text = (await disk.get('docs/read-me.txt')).toString()  // Buffer → string

await disk.exists('docs/read-me.txt')  // true
await disk.delete('docs/read-me.txt')  // true (existed and was deleted)
await disk.delete('docs/read-me.txt')  // false (no longer existed)

await disk.list('docs')  // ['docs/read-me.txt', ...] — recursive, sorted
await disk.list()        // every file in the current scope
```

`get` on a missing file throws `StorageFileNotFoundError`.

## Validating keys & uploads

Object keys are validated on every operation across **all** drivers: a key with
a leading slash, a `..` segment, or control characters is rejected with
`StorageInvalidKeyError` — so a user-supplied key can never escape its prefix or
collide with another tenant's.

Uploads are unrestricted by default **at this layer** (the higher-level
[`@basaltkit/files`](/guide/files) pipeline caps uploads at 25 MiB even when you
configure nothing); pass opt-in limits to `put` to cap size and constrain the
content type (enforced at the facade, before any driver runs):

```ts
await disk.put(key, buffer, {
  contentType: 'image/png',
  maxBytes: 5 * 1024 * 1024,                          // → StorageTooLargeError above 5 MiB
  allowedContentTypes: ['image/png', 'image/jpeg'],   // → StorageContentTypeError otherwise
})
```

## Large files

`put`/`get` move the whole object through memory, which is the wrong shape for
a 2 GB video, a CSV import or a database dump. Four **optional driver
capabilities** cover that case. `local`, `s3`, `azure` and `gcs` implement all
four; a driver that does not throws a clear `STORAGE_*_UNSUPPORTED` error, and
`disk.supports(capability)` answers before you call.

```ts
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

// Upload without ever holding the body. Source: Node Readable, web
// ReadableStream, or any AsyncIterable<Uint8Array>.
await disk.putStream('imports/2026.csv', request.raw, {
  contentType: 'text/csv',
  contentLength: declaredSize,        // when the client sent a Content-Length
  maxBytes: 200 * 1024 * 1024,        // enforced WHILE it streams
})

// Download as a stream — consume it or destroy() it, never abandon it.
await pipeline(await disk.getStream('imports/2026.csv'), createWriteStream('/tmp/2026.csv'))

// Copy without the bytes leaving the backend.
await disk.copy('drafts/a.pdf', 'final/a.pdf')
await disk.copy('drafts/a.pdf', 'a.pdf', { disk: storage.disk('cold') })

// Metadata without a download.
const { size, contentType, etag, lastModified } = await disk.stat('final/a.pdf')
```

Same safety rules as `put`: the key is validated and tenant-prefixed (failing
closed without a tenant), `allowedContentTypes` is checked before a single byte
is read, and past `maxBytes` the upload is aborted with `StorageTooLargeError`
while the source is destroyed (Node `Readable`) or cancelled (web
`ReadableStream`) — nothing beyond the cap is ever read.

| Capability | S3 | Azure | GCS | Local |
| --- | --- | --- | --- | --- |
| `putStream` | `PutObject` — needs `contentLength` **or** `maxBytes` | `uploadStream` (any length) | `createWriteStream` (any length) | `fs` write stream |
| `getStream` | `GetObject` body | `download()` | `createReadStream` | `fs` read stream |
| `copy` | `CopyObject` | `syncCopyFromURL` (≤ 256 MiB) | `file.copy()` | `fs.copyFile` |
| `stat` | `HeadObject` | `getProperties()` | `getMetadata()` | `fs.stat` (size + mtime only) |

::: warning S3 needs a known length
`PutObject` cannot send a body of unknown size. `putStream` streams straight
through when you pass `contentLength`; with only `maxBytes` it buffers up to
that cap (bounded memory, chosen deliberately); with neither it throws
`StorageStreamLengthRequiredError` (`400 STORAGE_STREAM_LENGTH_REQUIRED`). For
genuinely unbounded streams, drive `@aws-sdk/lib-storage`'s multipart `Upload`
yourself — it is deliberately not a dependency of `@basaltkit/storage-s3`.
Azure and GCS chunk unknown-length streams natively.
:::

`copy` falls back when a server-side copy is impossible — a different driver, or
one without `copy`: first `getStream` → `putStream`, then `get` → `put`. Both
fallbacks move the bytes through this process, so pass
`{ requireServerSide: true }` where a quiet download-and-re-upload of a huge
object would be a bug (`CopyUnsupportedError`). A failed streaming upload can
leave a partial object on backends that cannot roll one back; delete the key
when that matters (`@basaltkit/files` already does).

## Multiple named disks

Declare as many disks as you like — e.g. public uploads on one backend, invoices
on another — and pick one by name:

```ts
storagePlugin({
  default: 'uploads',
  disks: {
    uploads:  { driver: 'local', root: './storage/uploads' },
    invoices: s3Disk({ bucket: 'company-invoices', region: 'eu-west-1' }),
  },
})

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', image)              // default disk
await storage.disk('invoices').put('2026/01.pdf', invoice) // by name
```

`storage.disk('unknown')` throws `UnknownDiskError`.

## Drivers

The backend is chosen per disk. `local` is the only string — it needs no client
library, just `fs`. Every cloud driver arrives as an instance from its own
package, with the SDK as a peer dependency you install:

```ts
import { s3Disk } from '@basaltkit/storage-s3'
import { GcsStorageDriver } from '@basaltkit/storage-gcs'
import { AzureBlobStorageDriver } from '@basaltkit/storage-azure'

storagePlugin({
  disks: {
    uploads: { driver: 'local', root: './storage' },
    s3:      s3Disk({ bucket: 'my-bucket', region: 'eu-west-1' }),
    gcs:   { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) },
    azure: { driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }) },
  },
})
```

| Driver | Package | Notes |
| --- | --- | --- |
| Local | `@basaltkit/storage` | Filesystem — dev and single-node. No `temporaryUrl` |
| S3 | `@basaltkit/storage-s3` | AWS S3, MinIO, Cloudflare R2 (peers: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) |
| GCS | `@basaltkit/storage-gcs` | Google Cloud Storage (peer: `@google-cloud/storage`) |
| Azure Blob | `@basaltkit/storage-azure` | Azure Blob (SAS signed URLs; peer: `@azure/storage-blob`) |

### S3, MinIO and Cloudflare R2

```bash
pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

`s3Disk()` talks to any S3-compatible service. For AWS, `bucket` (and usually
`region`) is enough — credentials come from the standard AWS chain. For MinIO or
R2, set an `endpoint`:

```ts
import { s3Disk } from '@basaltkit/storage-s3'
```

```ts
storagePlugin({
  disks: {
    uploads: s3Disk({
      bucket: 'my-app',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',          // MinIO / R2 — forcePathStyle becomes true automatically
      credentials: { accessKeyId: '…', secretAccessKey: '…' }, // omit to use the AWS environment
    }),
  },
})
```

Every disk option (`scope`, `onMissingScope`, `maxTemporaryUrlTtl`,
`maxTemporaryUploadUrlTtl`) can be passed to `s3Disk()` next to the driver
options — it splits them and forwards each to the right place.

**Encryption at rest.** The simplest setup is the bucket's own default
encryption (AWS already encrypts new objects with SSE-S3 by default; set a
bucket default KMS key if you need one) — nothing to configure here. When the
app must pin it, set `serverSideEncryption` and the driver sends it on every
`put` and signs it into every [pre-signed upload](#direct-browser-uploads):

```ts
s3Disk({ bucket: 'docs', serverSideEncryption: 'AES256' })                        // SSE-S3
s3Disk({ bucket: 'docs', serverSideEncryption: { kms: 'alias/docs-key' } })        // SSE-KMS
```

## Signed URLs

Hand a client a time-limited URL straight to the object, no proxying:

```ts
const url = await disk.temporaryUrl('reports/q1.pdf', '15m')
// top-level rendering (e.g. a PDF preview tab) is a deliberate opt-in:
const preview = await disk.temporaryUrl('reports/q1.pdf', '15m', { disposition: 'inline' })
```

Signed URLs serve `Content-Disposition: attachment` **by default** — an
uploaded HTML or SVG file downloads instead of rendering on the storage/CDN
origin (a stored-XSS vector when that origin shares cookies with your app).
Embedded uses (`<img>`, `<video>`) render regardless of disposition, so
avatars and previews inside pages keep working.

The expiry accepts a duration string (`'500ms'`, `'30s'`, `'15m'`, `'2h'`,
`'7d'`) or milliseconds. It is **capped at 7 days** by default (the S3 and GCS
signature limit, now enforced for every driver, Azure included): a signed URL is
a bearer credential that outlives the holder's membership, so a longer (or
non-positive) lifetime throws `TemporaryUrlTtlTooLongError`
(`400 STORAGE_TEMPORARY_URL_TTL`). Lower the cap per disk with
`maxTemporaryUrlTtl`. Supported by `s3`, GCS and Azure; the `local` driver
throws `TemporaryUrlUnsupportedError` (serve local files through a route in dev,
or run MinIO locally with an `s3` disk).

## Direct browser uploads

For large files, let the browser `PUT` straight to the bucket instead of
streaming through your server. The server mints a short-lived, **pre-signed
upload URL** bound to the exact content type (and size / checksum when given):

```ts
import { randomUUID } from 'node:crypto'

const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' } as const

// POST /uploads — the client says what it wants to upload; the server decides where.
const { contentType, size } = req.body            // validate with your schema first
const upload = await disk.temporaryUploadUrl(`uploads/${randomUUID()}.${ALLOWED[contentType]}`, {
  expiresIn: '5m',
  contentType,                                    // required, always signed
  contentLength: size,                            // signed: any other size is rejected
  maxBytes: 20 * 1024 * 1024,                     // → StorageTooLargeError above 20 MiB
  allowedContentTypes: Object.keys(ALLOWED),      // → StorageContentTypeError otherwise
})
return { url: upload.url, method: upload.method, headers: upload.headers, key: upload.key }
```

```ts
// Browser
const res = await fetch(url, { method, headers, body: file })   // send `headers` verbatim
if (!res.ok) throw new Error('upload failed')
await fetch('/uploads/complete', { method: 'POST', body: JSON.stringify({ key }) })
```

`temporaryUploadUrl` follows the same safety rules as `temporaryUrl`: the key is
validated, tenant-prefixed (and fails closed without a tenant), and the lifetime
is capped — by `maxTemporaryUploadUrlTtl`, which defaults to **1 hour** (or
`maxTemporaryUrlTtl` when that is lower). It returns
`{ url, method: 'PUT', headers, expiresAt, key }`; `key` is the full object key,
tenant prefix included.

| Driver | Binds `contentType` | Binds `contentLength` | `checksumSha256` |
| --- | --- | --- | --- |
| S3 | signed header | signed header | signed; S3 verifies the body |
| GCS | signed (V4) | signed `x-goog-content-length-range` | refused (`STORAGE_UPLOAD_URL_UNSUPPORTED`) |
| Azure | **not enforceable** (sent as a header) | **not enforceable** | refused (`STORAGE_UPLOAD_URL_UNSUPPORTED`) |
| Local | — the driver throws `TemporaryUploadUrlUnsupportedError` (`STORAGE_UPLOAD_URL_UNSUPPORTED`) | | |

On S3 the SSE headers from `serverSideEncryption` are signed too, so the client
cannot skip encryption. Azure uses a create/write-only SAS, which cannot bind
request headers.

::: warning Security checklist
- **Generate the key on the server** (e.g. a UUID) — never accept a path from the client.
- **Always bind `contentType`** (required) and **`contentLength`** — without a
  length the client can upload any size. Keep an allowlist of types.
- **Keep the TTL short** — minutes. The URL is a write credential for that key
  until it expires; anyone who has it can upload.
- **Tenant-prefix the key** — the default disk scope does this; don't turn it off for user uploads.
- **Treat the uploaded object as untrusted** until a "complete" step checks it
  (it exists, it is the size/type you expect — mandatory on Azure, where nothing
  is bound). Serve it with `temporaryUrl` (attachment by default), never inline.
- **Configure bucket CORS** to allow `PUT` from your app's origin with the
  returned headers, and nothing wider.
:::

### Signing for another endpoint

Sometimes the process that will *use* the URL reaches the bucket under a
different host than the API does: an isolated ingest worker on
`http://minio:9000` inside the container network, a public CDN alias in front of
S3. Sign for that host with a per-call `endpoint`, or a per-disk default:

```ts
await disk.temporaryUploadUrl(key, { expiresIn: '5m', contentType, endpoint: 'http://minio:9000' })
await disk.temporaryUrl(key, '15m', { endpoint: 'https://files.example.com' })

// default for every URL this disk signs (a per-call endpoint still wins)
s3Disk({ bucket: 'uploads', endpoint: 'http://minio:9000', signingEndpoint: 'https://files.example.com' })
```

Only the signed host changes — region, path style, credentials and SSE stay as
configured, and the bound `Content-Type` / `Content-Length` / checksum headers
are unchanged. **S3 only:** Azure derives a SAS from the blob client's account
host and GCS binds V4 signatures to the bucket host, so both refuse an override
with `STORAGE_TEMPORARY_URL_UNSUPPORTED` / `STORAGE_UPLOAD_URL_UNSUPPORTED`
rather than mint a URL for the wrong host.

::: warning A deployment value, never client input
The endpoint must be another name for the **same** bucket. A signature minted
for a host you do not control is a credential handed to that host, so never
build it from a request. It is validated (absolute `http(s)`, no credentials, no
query or fragment) — anything else throws
`StorageSigningEndpointInvalidError` (`400 STORAGE_SIGNING_ENDPOINT_INVALID`).
:::

`@basaltkit/files` builds an upload pipeline on top of this (validation, quota,
metadata) — see the [File uploads guide](/guide/files).

## Image pipeline

Every disk exposes a fluent image pipeline when `storagePlugin` is given an
`imageProcessor` (from `@basaltkit/image-sharp` — kept out of the core so apps
that never process images carry no native dependency):

```ts
import { SharpImageProcessor } from '@basaltkit/image-sharp'

storagePlugin({ disks: { /* … */ }, imageProcessor: new SharpImageProcessor() })

await disk.image('avatar.png').resize(256, 256).webp().save('avatar.webp')
```

Without a processor, the pipeline's terminal throws
`ImageProcessingUnavailableError`.

## Options reference

### `storagePlugin(options)`

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `disks` | `Record<string, DiskConfig>` | — (required) | The named disks; each picks a driver |
| `default` | `string` | first declared disk | Disk returned by `storage.disk()` with no argument |
| `imageProcessor` | `ImageProcessor` | none | Engine behind `disk.image(…)` — pass `SharpImageProcessor` from `@basaltkit/image-sharp` |

### `DiskConfig` (per disk)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `driver` | `'local' \| 's3' \| StorageDriver` | — (required) | `'local'` needs `root`; `'s3'` takes the S3 options; an instance plugs in GCS/Azure/custom |
| `scope` | `(() => string \| undefined) \| null` | `tenants/<ctx().tenant.id>` | Dynamic path prefix resolved on **every** operation — automatic tenant isolation. `null` disables it |
| `onMissingScope` | `'root' \| 'error'` | `'error'` with tenancy registered and the default `scope`; `'root'` otherwise | What an operation does when no tenant is in context: `'error'` throws `StorageTenantRequiredError`, `'root'` uses the key against the disk root. An explicit value always wins |
| `maxTemporaryUrlTtl` | `DurationInput` | `'7d'` | Longest lifetime `temporaryUrl` accepts; above it throws `TemporaryUrlTtlTooLongError` |
| `maxTemporaryUploadUrlTtl` | `DurationInput` | `'1h'` (or `maxTemporaryUrlTtl` if lower) | Longest lifetime `temporaryUploadUrl` accepts; above it throws `TemporaryUrlTtlTooLongError` |

### `PutOptions` (per `put`)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `contentType` | `string` | none | Stored/served content type (S3 sets `Content-Type`) |
| `maxBytes` | `number` | uncapped | Facade-enforced size cap — rejects with `STORAGE_TOO_LARGE` before any driver runs |
| `allowedContentTypes` | `readonly string[]` | any | Facade-enforced allowlist — a missing or unlisted `contentType` rejects with `STORAGE_CONTENT_TYPE` |

### `PutStreamInput` (per `putStream`)

Everything from `PutOptions` (`maxBytes`, `allowedContentTypes`) plus:

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `contentType` | `string` | — (required) | A stream has no bytes to fall back on, so the type is declared up front and checked against `allowedContentTypes` before any byte is read |
| `contentLength` | `number` | none | Exact body size when known. **Required by S3** unless `maxBytes` is set |

### `CopyOptions` (per `copy`)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `disk` | `Disk` | the source disk | Destination disk; the key is scoped against **that** disk |
| `contentType` | `string` | the source's | Content type for the destination object |
| `maxBytes` | `number` | uncapped | Cap for a fallback copy — the only one whose bytes pass through this process |
| `requireServerSide` | `boolean` | `false` | Throw `CopyUnsupportedError` instead of falling back to a download-and-re-upload |

### `StorageStat` (returned by `stat`)

| Field | Type | Notes |
| --- | --- | --- |
| `size` | `number` | Bytes |
| `contentType` | `string \| undefined` | Not reported by `local` |
| `etag` | `string \| undefined` | As the backend returns it; not reported by `local` |
| `lastModified` | `Date \| undefined` | `mtime` on `local` |

### `TemporaryUrlOptions` (per `temporaryUrl`)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `disposition` | `'attachment' \| 'inline'` | `'attachment'` | Fail-closed against uploaded HTML/SVG rendering top-level on the storage/CDN origin (stored XSS). Opt into `'inline'` only when top-level rendering is deliberate |
| `endpoint` | `string` | the driver's own | Sign for another host of the **same** bucket (S3 only; Azure/GCS refuse it). See [Signing for another endpoint](#signing-for-another-endpoint) |

### `TemporaryUploadUrlOptions` (per `temporaryUploadUrl`)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `expiresIn` | `DurationInput` | — (required) | URL lifetime, capped by `maxTemporaryUploadUrlTtl` |
| `contentType` | `string` | — (required) | The only content type the upload may declare — signed into the URL (S3, GCS) |
| `contentLength` | `number` | none | Exact body size in bytes — signed (S3, GCS). Omit it and any size is accepted |
| `checksumSha256` | `string` (base64) | none | SHA-256 of the body — signed and verified by S3; refused by GCS and Azure |
| `maxBytes` | `number` | uncapped | Facade-enforced cap on the declared `contentLength` (which becomes mandatory) |
| `allowedContentTypes` | `readonly string[]` | any | Facade-enforced allowlist for `contentType` |
| `endpoint` | `string` | the driver's own | Sign for another host of the **same** bucket — a deployment value, never client input (S3 only) |

### `s3Disk` / `S3StorageDriver` options

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `bucket` | `string` | — (required) | Target bucket |
| `region` | `string` | `'us-east-1'` | AWS region |
| `endpoint` | `string` | AWS | MinIO / R2 / any S3-compatible endpoint |
| `credentials` | `{ accessKeyId, secretAccessKey }` | AWS credential chain | Static credentials |
| `forcePathStyle` | `boolean` | `true` when `endpoint` is set | Path-style URLs (MinIO) |
| `serverSideEncryption` | `'AES256' \| { kms: string }` | none (bucket default applies) | SSE sent on every `put` and signed into every pre-signed upload |
| `signingEndpoint` | `string` | `endpoint` | Default host pre-signed URLs are signed for, when it differs from the one this process talks to. A per-call `endpoint` wins |

The disposition default is honoured by all three signing drivers — S3
(`ResponseContentDisposition`), GCS (`responseDisposition`) and Azure (SAS
`contentDisposition`).

## Failure modes & troubleshooting

| Class | Code | When |
| --- | --- | --- |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | `get` on a file that doesn't exist |
| `StorageInvalidKeyError` | `STORAGE_INVALID_KEY` | The key starts with `/`/`\\`, contains a `..` segment or control characters — the facade choke point rejects it on **every** operation, for every driver, before the tenant prefix is applied |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | A path escapes the disk root — the local driver's own second line of defence |
| `StorageTooLargeError` | `STORAGE_TOO_LARGE` | `put` (or `temporaryUploadUrl`) with `maxBytes` set and a larger payload / declared length |
| `StorageContentTypeError` | `STORAGE_CONTENT_TYPE` | `put` (or `temporaryUploadUrl`) with `allowedContentTypes` set and a missing/unlisted content type |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | `disk('name')` for a disk that isn't declared |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | `temporaryUrl` on a driver without support (e.g. `local`) |
| `TemporaryUrlTtlTooLongError` | `STORAGE_TEMPORARY_URL_TTL` (400) | `temporaryUrl` with a lifetime ≤ 0 or above `maxTemporaryUrlTtl` (default 7 days); `temporaryUploadUrl` above `maxTemporaryUploadUrlTtl` (default 1 hour) |
| `TemporaryUploadUrlUnsupportedError` | `STORAGE_UPLOAD_URL_UNSUPPORTED` | `temporaryUploadUrl` on a driver without support (e.g. `local`), or an option the backend cannot bind (`checksumSha256` on GCS/Azure) |
| `StorageUploadUrlInvalidError` | `STORAGE_UPLOAD_URL_INVALID` (400) | `temporaryUploadUrl` with a missing/malformed `contentType`, a non-integer `contentLength`, a malformed `checksumSha256`, or `maxBytes` without `contentLength` |
| `StorageTenantRequiredError` | `STORAGE_TENANT_REQUIRED` (400) | A tenant-scoped disk ran with no tenant in context while tenancy is registered — resolve a tenant, or give a central disk `scope: null` / `onMissingScope: 'root'` |
| `StorageInvalidScopeError` | `STORAGE_INVALID_SCOPE` | The tenant id (or a custom `scope`) is not a safe path prefix (`..`, a `/` inside the id, control characters) |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | `disk.image(…)` terminal with no `imageProcessor` configured |
| `PutStreamUnsupportedError` | `STORAGE_PUT_STREAM_UNSUPPORTED` | `putStream` on a driver without the capability — check `disk.supports('putStream')` first |
| `GetStreamUnsupportedError` | `STORAGE_GET_STREAM_UNSUPPORTED` | `getStream` on a driver without the capability |
| `CopyUnsupportedError` | `STORAGE_COPY_UNSUPPORTED` | `copy({ requireServerSide: true })` with no server-side copy available (a different driver, or one without `copy`) |
| `StatUnsupportedError` | `STORAGE_STAT_UNSUPPORTED` | `stat` on a driver without the capability |
| `StorageStreamLengthRequiredError` | `STORAGE_STREAM_LENGTH_REQUIRED` (400) | `putStream` on S3 with neither `contentLength` nor `maxBytes` |
| `StorageSigningEndpointInvalidError` | `STORAGE_SIGNING_ENDPOINT_INVALID` (400) | An `endpoint` override that is not an absolute `http(s)` URL, or carries credentials, a query string or a fragment |

All extend `BasaltError` and carry the `code` above.

## Writing a driver

A driver implements the `StorageDriver` contract — six required methods, plus
the optional capabilities it can honour:

```ts
import {
  StorageFileNotFoundError,
  type PutOptions,
  type StorageDriver,
  type TemporaryUploadUrl,
  type TemporaryUploadUrlDriverOptions,
} from '@basaltkit/storage'

export class MyStorageDriver implements StorageDriver {
  readonly name = 'my-backend'
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> { /* … */ }
  async get(path: string): Promise<Buffer> { /* throw StorageFileNotFoundError on miss */ throw 0 }
  async exists(path: string): Promise<boolean> { /* … */ return false }
  async delete(path: string): Promise<boolean> { /* returns whether it existed */ return false }
  async list(prefix: string): Promise<string[]> { /* keys under the prefix */ return [] }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> { /* optional */ throw 0 }
  // optional: pre-signed PUT — bind options.contentType (+ length/checksum) and return the headers to send
  async temporaryUploadUrl(path: string, expiresInMs: number, options: TemporaryUploadUrlDriverOptions): Promise<TemporaryUploadUrl> { throw 0 }
  // optional: large-object capabilities. `source` is ONE Node Readable that the
  // Disk layer already normalized and capped at options.maxBytes.
  async putStream(path: string, source: Readable, options: PutStreamOptions): Promise<void> { /* … */ }
  async getStream(path: string): Promise<Readable> { /* throw StorageFileNotFoundError on miss */ throw 0 }
  async copy(from: string, to: string, options?: CopyDriverOptions): Promise<void> { /* … */ }
  async stat(path: string): Promise<StorageStat> { /* … */ throw 0 }
  async disconnect(): Promise<void> {}
}
```

Leave out what your backend cannot do: `Disk` reports the gap as the matching
`STORAGE_*_UNSUPPORTED` error and `disk.supports(...)` returns `false`. One rule
is not optional: a driver that cannot honour a `TemporaryUrlOptions.endpoint`
override **must throw** rather than ignore it — a URL signed for the wrong host
is a silently broken one.

Then plug it in as an instance: `disks: { d: { driver: new MyStorageDriver() } }`.
The bundled cloud drivers ([`@basaltkit/storage-gcs`][gcs], [`-azure`][az]) take an
**injectable client**, so their logic is unit-tested with a fake — no cloud
account. Do the same and your driver is testable in CI.

[gcs]: https://github.com/basaltkit/basalt/tree/main/packages/storage-gcs
[az]: https://github.com/basaltkit/basalt/tree/main/packages/storage-azure
