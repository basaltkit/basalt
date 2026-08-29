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

Implements the `StorageDriver` contract — `put`, `get`, `exists`, `delete`, `list`, and **signed URLs** (SAS via `temporaryUrl`). Per-tenant isolation, key validation and the opt-in upload limits all happen in `Disk` above this driver, so they apply here unchanged.

## Options reference

`new AzureBlobStorageDriver(options: AzureDriverOptions)`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `container` | `string` | — (required) | Blob container the disk maps to. |
| `connectionString` | `string` | — | Azure Storage connection string. Required unless you inject `client`; missing both throws at first use. |
| `client` | `AzureContainerLike` | — | Pre-built container client. Bypasses `connectionString` and the dynamic `@azure/storage-blob` import — used by tests, or to reuse a client you already authenticate yourself. |

The `@azure/storage-blob` module is imported **lazily**, on the first operation,
so installing this package without using it costs nothing at boot.

## Signed URLs and content disposition

`temporaryUrl` mints a read-only SAS URL and pins the response disposition into
the SAS itself (`contentDisposition`). It defaults to `attachment` — matching
the `Disk` default — so an uploaded HTML or SVG blob downloads instead of
rendering top-level on the storage origin. Pass `{ disposition: 'inline' }`
through `disk.temporaryUrl(path, expiresIn, options)` when in-browser rendering
is deliberate.

## Errors

| Error | Code | HTTP | When |
|---|---|---|---|
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | 500 | `get()` on a blob that doesn't exist (Azure `404` / `BlobNotFound`). Re-exported from `@basaltkit/storage`. |

Any other Azure SDK error propagates unchanged. This driver defines no error
classes of its own; the facade-level errors (`STORAGE_INVALID_KEY`,
`STORAGE_TOO_LARGE`, `STORAGE_CONTENT_TYPE`, `STORAGE_TEMPORARY_URL_UNSUPPORTED`)
are raised by `Disk` before the driver is reached. Storage errors carry no HTTP
`status`, so the adapters surface them as a generic 500 `INTERNAL_ERROR` —
catch and map them in your handler.

## Hooks & events

None. Upload lifecycle events live in `@basaltkit/files`.

## Testable without the cloud

The container is **injectable**, so the driver logic can be tested with a fake — no Azure needed:

```ts
new AzureBlobStorageDriver({ container: 'c', client: fakeContainer })
```

## How it connects to other modules

- **`@basaltkit/storage`** — this is a driver for that package; the API (`Disk`, `storagePlugin`) comes from there.
- Sibling drivers: `S3StorageDriver` (in core) and [`@basaltkit/storage-gcs`](https://www.npmjs.com/package/@basaltkit/storage-gcs).

Guide: [Storage](/guide/storage).
