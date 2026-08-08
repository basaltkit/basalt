# @machize/storage-gcs

**Google Cloud Storage** driver for [`@machize/storage`](https://www.npmjs.com/package/@machize/storage): stores files on GCS without changing your app's code. You need this module when you run on Google Cloud and want GCS instead of S3 or local disk.

## Installation

```bash
pnpm add @machize/storage-gcs @google-cloud/storage
```

`@google-cloud/storage` is a **peer dependency**. Credentials follow GCP's standard chain (ADC, `keyFilename`, service account).

## Usage

```ts
import { storagePlugin } from '@machize/storage'
import { GcsStorageDriver } from '@machize/storage-gcs'

storagePlugin({
  disks: { uploads: { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) } },
})
```

Implements the `StorageDriver` contract — `put`, `get`, `exists`, `delete`, `list`, and **signed URLs** (`temporaryUrl`). Like all Machize disks, per-tenant isolation is automatic via `Disk`.

## Testable without the cloud

The client (bucket) is **injectable**, so the driver's logic can be tested with a fake — no GCS required:

```ts
new GcsStorageDriver({ bucket: 'b', client: fakeBucket })
```

## How it connects to other modules

- **`@machize/storage`** — this is a driver for that package; the API (`Disk`, `storagePlugin`) comes from there.
- Sibling drivers: `S3StorageDriver` (in core) and [`@machize/storage-azure`](https://www.npmjs.com/package/@machize/storage-azure).
