<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/storage-s3

**S3-compatible** storage driver for [`@basaltkit/storage`](https://www.npmjs.com/package/@basaltkit/storage) — AWS S3, MinIO, Cloudflare R2, Backblaze B2, and anything else speaking the S3 API. Includes presigned `temporaryUrl`s.

## What this module solves

`@basaltkit/storage` gives every backend one API — a **Disk** with `put`/`get`/`exists`/`delete`/`list` — and scopes every path by tenant. This package is the S3 driver behind it.

It used to live in the core, reachable as `{ driver: 's3' }`. That meant **every** consumer of `@basaltkit/storage` installed the AWS SDK — about **4.4 MB** — including apps running only the local driver, Azure or GCS. Now you install it only if you use it.

## Installation

```bash
pnpm add @basaltkit/storage @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

The two AWS packages are **peer dependencies**: you install them explicitly, which is what keeps them out of everyone else's tree.

`@aws-sdk/lib-storage` is an **optional** peer. Install it only if you upload streams whose length you do not know up front — see [Unbounded streams](#unbounded-streams-multipart):

```bash
pnpm add @aws-sdk/lib-storage
```

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { storagePlugin, STORAGE } from '@basaltkit/storage'
import { s3Disk } from '@basaltkit/storage-s3'

const app = await createApp({
  plugins: [
    storagePlugin({
      default: 'uploads',
      disks: {
        uploads: s3Disk({ bucket: 'my-app', region: 'eu-west-1' }),
      },
    }),
  ],
}).boot()

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', image)
const url = await storage.disk().temporaryUrl('avatar.png', '15m')
```

### MinIO, R2 and other S3-compatible services

Set an `endpoint`. `forcePathStyle` flips to `true` automatically when you do, which is what MinIO requires:

```ts
s3Disk({
  bucket: 'my-app',
  endpoint: 'http://localhost:9000',
  credentials: { accessKeyId: '…', secretAccessKey: '…' },
})
```

Omit `credentials` on AWS to use the standard credential chain (environment, profile, instance role).

### Direct browser uploads

`disk.temporaryUploadUrl(key, { expiresIn, contentType, contentLength?, checksumSha256? })` presigns a `PutObject`. Content-Type — and Content-Length, the SHA-256 checksum and the SSE headers when present — are signed as **headers** (not query parameters), so S3 rejects an upload that omits or changes any of them; with `checksumSha256` S3 also verifies the body. Send the returned `headers` verbatim. Uploads are presigned without the SDK's default CRC32 checksum (which would otherwise pin the checksum of an empty body and break every upload). See the [Storage guide](https://basaltkit-docs.pages.dev/guide/storage#direct-browser-uploads) for the browser flow and security checklist.

### Streaming, copy and stat

This driver implements all four optional capabilities:

| Capability | S3 call | Notes |
|---|---|---|
| `putStream` | `PutObject`, or multipart | Pass `contentLength` (the stream goes straight to S3) or `maxBytes` (the body is buffered up to that cap). With **neither**, the body is uploaded **multipart** when the optional peer `@aws-sdk/lib-storage` is installed; without it → `STORAGE_STREAM_LENGTH_REQUIRED` (400). See [Unbounded streams](#unbounded-streams-multipart). |
| `getStream` | `GetObject` | Returns the response body as a Node `Readable`; consume it or `destroy()` it. |
| `copy` | `CopyObject` | Server-side within the same bucket; the bytes never reach the process. A given `contentType` sets `MetadataDirective: 'REPLACE'`. SSE is re-applied. |
| `stat` | `HeadObject` | `{ size, contentType, etag, lastModified }`. |

### Unbounded streams (multipart)

`PutObject` cannot send a body of unknown size in one request. When `putStream`
is given **neither** `contentLength` **nor** `maxBytes`, the driver falls back to
a **multipart upload** — `CreateMultipartUpload` → `UploadPart`… →
`CompleteMultipartUpload` — so a stream of any size goes through while only
`partSizeBytes × queueSize` bytes are ever in memory.

That path needs `@aws-sdk/lib-storage`, an **optional peer dependency**:

```bash
pnpm add @aws-sdk/lib-storage
```

It is never imported at module load — it is resolved lazily, inside that one
code path, the first time it is needed. An app that does not install it behaves
exactly as before: `putStream` with neither option throws
`STORAGE_STREAM_LENGTH_REQUIRED` (400), and the message names the package.

Nothing else changes: `contentLength` still streams straight into `PutObject`,
`maxBytes` still buffers up to the cap and sends one object, and a multipart
object carries the same tenant-scoped `Key`, `ContentType` and server-side
encryption a single-shot `PutObject` would.

```ts
s3Disk({
  bucket: 'my-app',
  partSizeBytes: 16 * 1024 * 1024, // default: 5 MiB (S3's minimum — smaller is rejected)
  queueSize: 4,                    // default: 4 parts in parallel
})

// or per call, straight on the driver
await driver.putStream(key, stream, { contentType: 'text/csv', partSizeBytes: 8 * 1024 * 1024 })
```

| Option | Default | Notes |
|---|---|---|
| `partSizeBytes` | `5 MiB` (`S3_MIN_PART_SIZE_BYTES`) | Bytes per part. Must be an integer ≥ 5 MiB — S3's minimum for every part but the last. Bigger parts mean fewer requests and more memory. |
| `queueSize` | `4` | Parts uploaded in parallel. Must be ≥ 1. Peak memory is roughly `partSizeBytes × queueSize`. |

Both are validated when the driver is constructed, so a misconfigured disk fails
at boot rather than on the first large upload.

**Failures abort the upload.** If a part fails — including the facade's
`maxBytes` cap firing mid-stream — the driver aborts the multipart upload and
destroys the source, so S3 keeps no orphan parts. Incomplete parts are invisible
in listings and **billed** until removed, so set the belt-and-braces lifecycle
rule on the bucket as well:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    }
  ]
}
```

### Pre-signing for another endpoint

When the process that will use the URL reaches the bucket under a different
host than this one does — an ingest worker on `http://minio:9000` inside the
container network, a public CDN alias — sign for that host:

```ts
// per call
await disk.temporaryUploadUrl(key, { expiresIn: '5m', contentType: 'image/png', endpoint: 'http://minio:9000' })
await disk.temporaryUrl(key, '15m', { endpoint: 'https://files.example.com' })

// or a default for the disk
s3Disk({ bucket: 'my-app', endpoint: 'http://minio:9000', signingEndpoint: 'https://files.example.com' })
```

Only the signed host changes: region, path style, credentials and SSE stay as
configured, and the signed `Content-Type`/`Content-Length`/checksum headers are
unchanged. It is a **deployment** value — always the SAME bucket under another
name, never client input, never a third party. Invalid values (relative, non
`http(s)`, credentials in the URL, a query string) throw
`STORAGE_SIGNING_ENDPOINT_INVALID` (400).

### Server-side encryption

The simplest option is the bucket's default encryption — nothing to set here. To pin it from the app:

```ts
s3Disk({ bucket: 'docs', serverSideEncryption: 'AES256' })                 // SSE-S3
s3Disk({ bucket: 'docs', serverSideEncryption: { kms: 'alias/docs-key' } }) // SSE-KMS
```

It is sent with every `put` and signed into every pre-signed upload.

## API reference

### `s3Disk(options)`

Returns a disk config for `storagePlugin({ disks })`. Takes every `S3DriverOptions` field plus every `DiskOptions` field (`scope`, `onMissingScope`, `maxTemporaryUrlTtl`, `maxTemporaryUploadUrlTtl`, …) and forwards each to the driver or the disk.

| Option | Type | Required? | Description |
|---|---|---|---|
| `bucket` | `string` | Yes | The bucket name |
| `region` | `string` | No | AWS region |
| `endpoint` | `string` | No | Custom endpoint — set it for MinIO, R2 and friends |
| `credentials` | `{ accessKeyId, secretAccessKey }` | No | Omit on AWS to use the standard chain |
| `forcePathStyle` | `boolean` | No | Path-style URLs. Defaults to `true` when `endpoint` is set |
| `serverSideEncryption` | `'AES256' \| { kms: string }` | No | SSE on every put and pre-signed upload. Default: none sent (bucket default applies) |
| `signingEndpoint` | `string` | No | Default host pre-signed URLs are signed for, when it differs from `endpoint`. A per-call `endpoint` wins |
| `partSizeBytes` | `number` | No | Bytes per multipart part. Default `5 MiB`, which is also the minimum S3 accepts |
| `queueSize` | `number` | No | Multipart parts uploaded in parallel. Default `4` |
| `scope` | `DiskOptions['scope']` | No | Per-disk tenant scoping, as on any other disk |
| `onMissingScope` | `'root' \| 'error'` | No | Behaviour with no tenant in context |
| `maxTemporaryUrlTtl` | `DurationInput` | No | Cap for `temporaryUrl` lifetimes (default `'7d'`) |
| `maxTemporaryUploadUrlTtl` | `DurationInput` | No | Cap for `temporaryUploadUrl` lifetimes (default `'1h'`) |

### `new S3StorageDriver(options)`

The driver itself, for the rarer cases — sharing one driver across disks, wrapping it, or testing it:

```ts
import { S3StorageDriver } from '@basaltkit/storage-s3'

storagePlugin({ disks: { uploads: { driver: new S3StorageDriver({ bucket: 'my-app' }) } } })
```

## How it connects to other modules

- **`@basaltkit/storage`** — this is a driver for that package; the whole Disk API comes from there.
- Sibling drivers: [`@basaltkit/storage-azure`](https://www.npmjs.com/package/@basaltkit/storage-azure) and [`@basaltkit/storage-gcs`](https://www.npmjs.com/package/@basaltkit/storage-gcs), plus the [Storage](https://basaltkit-docs.pages.dev/guide/storage) guide.
