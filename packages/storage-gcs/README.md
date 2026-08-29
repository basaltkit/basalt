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

Implements the `StorageDriver` contract — `put`, `get`, `exists`, `delete`, `list`, and **signed URLs** (`temporaryUrl`). Per-tenant isolation, key validation and the opt-in upload limits all happen in `Disk` above this driver, so they apply here unchanged.

## Options reference

`new GcsStorageDriver(options: GcsDriverOptions)`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `bucket` | `string` | — (required) | Bucket the disk maps to. |
| `projectId` | `string` | from the ambient GCP credentials | Pin the project explicitly instead of inheriting it from ADC. |
| `keyFilename` | `string` | ADC chain | Path to a service-account JSON key. Omit it on GCE/GKE/Cloud Run and let Application Default Credentials work. |
| `client` | `GcsBucketLike` | — | Pre-built bucket handle. Bypasses `projectId`/`keyFilename` and the dynamic `@google-cloud/storage` import — used by tests, or to reuse a client you already authenticate yourself. |

The `@google-cloud/storage` module is imported **lazily**, on the first
operation, so installing this package without using it costs nothing at boot.

## Signed URLs and content disposition

`temporaryUrl` signs a `read` URL and pins the response disposition into the
signature (`responseDisposition`). It defaults to `attachment` — matching the
`Disk` default — so an uploaded HTML or SVG object downloads instead of
rendering top-level on the storage origin. Pass `{ disposition: 'inline' }`
through `disk.temporaryUrl(path, expiresIn, options)` when in-browser rendering
is deliberate.

`delete()` checks `exists()` first so it can return `false` for a missing object
rather than throwing — that costs one extra round-trip per delete.

## Errors

| Error | Code | HTTP | When |
|---|---|---|---|
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | 500 | `get()` on an object that doesn't exist (GCS error `code: 404`). Re-exported from `@basaltkit/storage`. |

Any other GCS client error propagates unchanged. This driver defines no error
classes of its own; the facade-level errors (`STORAGE_INVALID_KEY`,
`STORAGE_TOO_LARGE`, `STORAGE_CONTENT_TYPE`, `STORAGE_TEMPORARY_URL_UNSUPPORTED`)
are raised by `Disk` before the driver is reached. Storage errors carry no HTTP
`status`, so the adapters surface them as a generic 500 `INTERNAL_ERROR` —
catch and map them in your handler.

## Hooks & events

None. Upload lifecycle events live in `@basaltkit/files`.

## Testable without the cloud

The client (bucket) is **injectable**, so the driver's logic can be tested with a fake — no GCS required:

```ts
new GcsStorageDriver({ bucket: 'b', client: fakeBucket })
```

## How it connects to other modules

- **`@basaltkit/storage`** — this is a driver for that package; the API (`Disk`, `storagePlugin`) comes from there.
- Sibling drivers: `S3StorageDriver` (in core) and [`@basaltkit/storage-azure`](https://www.npmjs.com/package/@basaltkit/storage-azure).

Guide: [Storage](/guide/storage).
