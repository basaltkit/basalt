<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/storage-azure

An **Azure Blob Storage** driver for [`@basaltkit/storage`](https://www.npmjs.com/package/@basaltkit/storage): stores files in Azure Blob without changing your app code. You need this module when you run on Azure and want Blob Storage instead of S3, GCS, or local disk.

## Installation

```bash
pnpm add @basaltkit/storage-azure @azure/storage-blob
```

`@azure/storage-blob` is a **peer dependency**.

## Usage

```ts
import { storagePlugin } from '@basaltkit/storage'
import { AzureBlobStorageDriver } from '@basaltkit/storage-azure'

storagePlugin({
  disks: {
    uploads: {
      driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }),
    },
  },
})
```

Implements the `StorageDriver` contract — `put`, `get`, `exists`, `delete`, `list`, and **signed URLs** (SAS via `temporaryUrl`). Per-tenant isolation is automatic via `Disk`.

## Testable without the cloud

The container is **injectable**, so the driver logic can be tested with a fake — no Azure needed:

```ts
new AzureBlobStorageDriver({ container: 'c', client: fakeContainer })
```

## How it connects to other modules

- **`@basaltkit/storage`** — this is a driver for that package; the API (`Disk`, `storagePlugin`) comes from there.
- Sibling drivers: `S3StorageDriver` (in core) and [`@basaltkit/storage-gcs`](https://www.npmjs.com/package/@basaltkit/storage-gcs).
