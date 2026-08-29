# Storage

`@basaltkit/storage` gives every backend one API — a **Disk** with
`put`/`get`/`exists`/`delete`/`list` and signed `temporaryUrl`s — and scopes
every path by tenant automatically. Local disk and S3 ship in the core; Google
Cloud Storage and Azure Blob are drop-in driver packages.

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

## Multiple named disks

Declare as many disks as you like — e.g. public uploads on one backend, invoices
on another — and pick one by name:

```ts
storagePlugin({
  default: 'uploads',
  disks: {
    uploads:  { driver: 'local', root: './storage/uploads' },
    invoices: { driver: 's3', bucket: 'company-invoices', region: 'eu-west-1' },
  },
})

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', image)              // default disk
await storage.disk('invoices').put('2026/01.pdf', invoice) // by name
```

`storage.disk('unknown')` throws `UnknownDiskError`.

## Drivers

The backend is chosen per disk. `local` and `s3` are strings; cloud drivers are
instances (bring the SDK as a peer dependency):

```ts
import { GcsStorageDriver } from '@basaltkit/storage-gcs'
import { AzureBlobStorageDriver } from '@basaltkit/storage-azure'

storagePlugin({
  disks: {
    gcs:   { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) },
    azure: { driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }) },
  },
})
```

| Driver | Package | Notes |
| --- | --- | --- |
| Local | `@basaltkit/storage` | Filesystem — dev and single-node. No `temporaryUrl` |
| S3 | `@basaltkit/storage` | AWS S3, MinIO, Cloudflare R2 (S3-compatible) |
| GCS | `@basaltkit/storage-gcs` | Google Cloud Storage (peer: `@google-cloud/storage`) |
| Azure Blob | `@basaltkit/storage-azure` | Azure Blob (SAS signed URLs; peer: `@azure/storage-blob`) |

### S3, MinIO and Cloudflare R2

The `s3` driver talks to any S3-compatible service. For AWS, `bucket` (and
usually `region`) is enough — credentials come from the standard AWS chain. For
MinIO or R2, set an `endpoint`:

```ts
storagePlugin({
  disks: {
    uploads: {
      driver: 's3',
      bucket: 'my-app',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',          // MinIO / R2 — forcePathStyle becomes true automatically
      credentials: { accessKeyId: '…', secretAccessKey: '…' }, // omit to use the AWS environment
    },
  },
})
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
`'7d'`) or milliseconds. Supported by `s3`, GCS and Azure; the `local` driver
throws `TemporaryUrlUnsupportedError` (serve local files through a route in dev,
or run MinIO locally with an `s3` disk).

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

### `PutOptions` (per `put`)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `contentType` | `string` | none | Stored/served content type (S3 sets `Content-Type`) |
| `maxBytes` | `number` | uncapped | Facade-enforced size cap — rejects with `STORAGE_TOO_LARGE` before any driver runs |
| `allowedContentTypes` | `readonly string[]` | any | Facade-enforced allowlist — a missing or unlisted `contentType` rejects with `STORAGE_CONTENT_TYPE` |

### `TemporaryUrlOptions` (per `temporaryUrl`)

| Option | Type | Default | Why |
| --- | --- | --- | --- |
| `disposition` | `'attachment' \| 'inline'` | `'attachment'` | Fail-closed against uploaded HTML/SVG rendering top-level on the storage/CDN origin (stored XSS). Opt into `'inline'` only when top-level rendering is deliberate |

The disposition default is honoured by all three signing drivers — S3
(`ResponseContentDisposition`), GCS (`responseDisposition`) and Azure (SAS
`contentDisposition`).

## Failure modes & troubleshooting

| Class | Code | When |
| --- | --- | --- |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | `get` on a file that doesn't exist |
| `StorageInvalidKeyError` | `STORAGE_INVALID_KEY` | The key starts with `/`/`\\`, contains a `..` segment or control characters — the facade choke point rejects it on **every** operation, for every driver, before the tenant prefix is applied |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | A path escapes the disk root — the local driver's own second line of defence |
| `StorageTooLargeError` | `STORAGE_TOO_LARGE` | `put` with `maxBytes` set and a larger payload |
| `StorageContentTypeError` | `STORAGE_CONTENT_TYPE` | `put` with `allowedContentTypes` set and a missing/unlisted content type |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | `disk('name')` for a disk that isn't declared |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | `temporaryUrl` on a driver without support (e.g. `local`) |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | `disk.image(…)` terminal with no `imageProcessor` configured |

All extend `BasaltError` and carry the `code` above.

## Writing a driver

A driver implements the `StorageDriver` contract — six methods:

```ts
import { StorageFileNotFoundError, type PutOptions, type StorageDriver } from '@basaltkit/storage'

export class MyStorageDriver implements StorageDriver {
  readonly name = 'my-backend'
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> { /* … */ }
  async get(path: string): Promise<Buffer> { /* throw StorageFileNotFoundError on miss */ throw 0 }
  async exists(path: string): Promise<boolean> { /* … */ return false }
  async delete(path: string): Promise<boolean> { /* returns whether it existed */ return false }
  async list(prefix: string): Promise<string[]> { /* keys under the prefix */ return [] }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> { /* optional */ throw 0 }
  async disconnect(): Promise<void> {}
}
```

Then plug it in as an instance: `disks: { d: { driver: new MyStorageDriver() } }`.
The bundled cloud drivers ([`@basaltkit/storage-gcs`][gcs], [`-azure`][az]) take an
**injectable client**, so their logic is unit-tested with a fake — no cloud
account. Do the same and your driver is testable in CI.

[gcs]: https://github.com/basaltkit/basalt/tree/main/packages/storage-gcs
[az]: https://github.com/basaltkit/basalt/tree/main/packages/storage-azure
