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

## API reference

### `s3Disk(options)`

Returns a disk config for `storagePlugin({ disks })`. Takes every `S3DriverOptions` field plus the disk's own `scope`.

| Option | Type | Required? | Description |
|---|---|---|---|
| `bucket` | `string` | Yes | The bucket name |
| `region` | `string` | No | AWS region |
| `endpoint` | `string` | No | Custom endpoint — set it for MinIO, R2 and friends |
| `credentials` | `{ accessKeyId, secretAccessKey }` | No | Omit on AWS to use the standard chain |
| `forcePathStyle` | `boolean` | No | Path-style URLs. Defaults to `true` when `endpoint` is set |
| `scope` | `DiskOptions['scope']` | No | Per-disk tenant scoping, as on any other disk |

### `new S3StorageDriver(options)`

The driver itself, for the rarer cases — sharing one driver across disks, wrapping it, or testing it:

```ts
import { S3StorageDriver } from '@basaltkit/storage-s3'

storagePlugin({ disks: { uploads: { driver: new S3StorageDriver({ bucket: 'my-app' }) } } })
```

## How it connects to other modules

- **`@basaltkit/storage`** — this is a driver for that package; the whole Disk API comes from there.
- Sibling drivers: [`@basaltkit/storage-azure`](https://www.npmjs.com/package/@basaltkit/storage-azure) and [`@basaltkit/storage-gcs`](https://www.npmjs.com/package/@basaltkit/storage-gcs), plus the [Storage](https://basaltkit-docs.pages.dev/guide/storage) guide.
