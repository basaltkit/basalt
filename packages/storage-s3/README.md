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
| `putStream` | `PutObject` | Needs a **known length**: pass `contentLength` (the stream goes straight to S3) or `maxBytes` (the body is buffered up to that cap). With neither → `STORAGE_STREAM_LENGTH_REQUIRED` (400). For unbounded streams, drive `@aws-sdk/lib-storage`'s multipart `Upload` yourself — it is deliberately **not** a dependency here. |
| `getStream` | `GetObject` | Returns the response body as a Node `Readable`; consume it or `destroy()` it. |
| `copy` | `CopyObject` | Server-side within the same bucket; the bytes never reach the process. A given `contentType` sets `MetadataDirective: 'REPLACE'`. SSE is re-applied. |
| `stat` | `HeadObject` | `{ size, contentType, etag, lastModified }`. |

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
