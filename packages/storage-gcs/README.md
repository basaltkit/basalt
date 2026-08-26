<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/storage-gcs

**Google Cloud Storage** driver for [`@basaltkit/storage`](https://www.npmjs.com/package/@basaltkit/storage): stores files on GCS without changing your app's code. You need this module when you run on Google Cloud and want GCS instead of S3 or local disk.

## Installation

```bash
pnpm add @basaltkit/storage-gcs @google-cloud/storage
```

`@google-cloud/storage` is a **peer dependency**. Credentials follow GCP's standard chain (ADC, `keyFilename`, service account).

## Usage

```ts
import { storagePlugin } from '@basaltkit/storage'
import { GcsStorageDriver } from '@basaltkit/storage-gcs'

storagePlugin({
  disks: { uploads: { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) } },
})
```

Implements the `StorageDriver` contract — `put`, `get`, `exists`, `delete`, `list`, and **signed URLs** (`temporaryUrl`). Like all Basalt disks, per-tenant isolation is automatic via `Disk`.

## Testable without the cloud

The client (bucket) is **injectable**, so the driver's logic can be tested with a fake — no GCS required:

```ts
new GcsStorageDriver({ bucket: 'b', client: fakeBucket })
```

## How it connects to other modules

- **`@basaltkit/storage`** — this is a driver for that package; the API (`Disk`, `storagePlugin`) comes from there.
- Sibling drivers: `S3StorageDriver` (in core) and [`@basaltkit/storage-azure`](https://www.npmjs.com/package/@basaltkit/storage-azure).
