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

## Direct browser uploads

`temporaryUploadUrl` (via `disk.temporaryUploadUrl(...)`) mints a **create/write-only**
SAS (no read, list or delete) and returns the headers Put Blob needs
(`x-ms-blob-type: BlockBlob`, `Content-Type`, `Content-Length`). The lifetime is
capped by the Disk (default 1 hour) and, when called directly, at 7 days.

**Caveat:** an Azure SAS cannot bind request headers, so — unlike S3 and GCS —
the declared content type and length are **not enforced** by the signature.
Keep the TTL short, generate the key server-side, and verify the blob (size,
type) in a "complete" step before trusting it. `checksumSha256` is refused with
`STORAGE_UPLOAD_URL_UNSUPPORTED` (Put Blob verifies MD5/CRC64 only).

## Streaming, copy and stat

All four optional capabilities are implemented:

| Capability | Azure call | Notes |
|---|---|---|
| `putStream` | `uploadStream` | The SDK splits the readable into blocks, so a body of **unknown length** streams fine — no `contentLength` needed. |
| `getStream` | `download()` | Returns `readableStreamBody` as a Node `Readable`; consume it or `destroy()` it. |
| `copy` | `syncCopyFromURL` | The destination pulls the source through a **5-minute read-only SAS**, so the bytes never reach the process. Azure caps Copy Blob From URL at **256 MiB** — copy larger blobs with `beginCopyFromURL` on the SDK client, or stream them with `getStream`/`putStream`. |
| `stat` | `getProperties()` | `{ size, contentType, etag, lastModified }`. |

An injected fake `client` that omits one of these methods makes that capability
report `STORAGE_*_UNSUPPORTED` instead of crashing.

**Endpoint overrides are refused.** A SAS URL is derived from the blob client's
own account host and the SDK offers no way to sign for another one, so
`{ endpoint }` on `temporaryUrl` / `temporaryUploadUrl` throws
`STORAGE_TEMPORARY_URL_UNSUPPORTED` / `STORAGE_UPLOAD_URL_UNSUPPORTED` rather
than minting a URL for the wrong host. Configure the driver with a connection
string for that endpoint instead.

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
