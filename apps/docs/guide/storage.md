# Storage

`@basaltkit/storage` gives every backend one API — a **Disk** with
`put`/`get`/`exists`/`delete`/`list` and signed `temporaryUrl`s — and scopes
every path by tenant automatically. Local disk and S3 ship in the core; Google
Cloud Storage and Azure Blob are drop-in driver packages.

[[toc]]

## Setup

```ts
import { storagePlugin, STORAGE } from '@basaltkit/storage'

storagePlugin({
  default: 'uploads',
  disks: {
    uploads: { driver: 'local', root: './storage' },     // dev
    // uploads: { driver: 's3', bucket: 'my-bucket', region: 'eu-west-1' }, // prod
  },
})

const disk = app.container.get(STORAGE).disk()   // the default disk
await disk.put('avatars/1.png', buffer, { contentType: 'image/png' })
```

Each `Disk` prefixes paths with `tenants/<id>` from `ctx().tenant` — so the same
code keeps every tenant's files isolated. Pass `scope: null` on a disk to turn
that off.

## Drivers

The backend is chosen per disk. `local` and `s3` are strings; cloud drivers are
instances (bring the SDK as a peer dependency):

```ts
import { GcsStorageDriver } from '@basaltkit/storage-gcs'
import { AzureBlobStorageDriver } from '@basaltkit/storage-azure'

storagePlugin({
  disks: {
    gcs:   { driver: new GcsStorageDriver({ bucket: 'my-bucket' }) },
    azure: { driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }) },
  },
})
```

| Driver | Package | Notes |
| --- | --- | --- |
| Local | `@basaltkit/storage` | Filesystem — dev and single-node |
| S3 | `@basaltkit/storage` | AWS S3, MinIO, Cloudflare R2 (S3-compatible) |
| GCS | `@basaltkit/storage-gcs` | Google Cloud Storage |
| Azure Blob | `@basaltkit/storage-azure` | Azure Blob Storage (SAS signed URLs) |

## Signed URLs

Hand a client a time-limited URL straight to the object, no proxying:

```ts
const url = await disk.temporaryUrl('reports/q1.pdf', '15m')
```

`@basaltkit/files` builds an upload pipeline on top of this (validation, quota,
metadata) — see the [File uploads guide](/guide/files).

## Writing a driver

A driver implements the `StorageDriver` contract — six methods:

```ts
import { StorageFileNotFoundError, type PutOptions, type StorageDriver } from '@basaltkit/storage'

export class MyStorageDriver implements StorageDriver {
  readonly name = 'my-backend'
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> { /* … */ }
  async get(path: string): Promise<Buffer> { /* throw StorageFileNotFoundError on miss */ }
  async exists(path: string): Promise<boolean> { /* … */ }
  async delete(path: string): Promise<boolean> { /* returns whether it existed */ }
  async list(prefix: string): Promise<string[]> { /* keys under the prefix */ }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> { /* optional */ }
  async disconnect(): Promise<void> {}
}
```

Then plug it in as an instance: `disks: { d: { driver: new MyStorageDriver() } }`.
The bundled cloud drivers ([`@basaltkit/storage-gcs`][gcs], [`-azure`][az]) take an
**injectable client**, so their logic is unit-tested with a fake — no cloud
account. Do the same and your driver is testable in CI.

[gcs]: https://github.com/Zebedeu/basalt/tree/main/packages/storage-gcs
[az]: https://github.com/Zebedeu/basalt/tree/main/packages/storage-azure
