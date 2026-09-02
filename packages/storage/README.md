<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/storage

Basalt's file storage layer: stores, reads and deletes files (uploads, reports, images, invoices…) with the same API, whether they live on local disk or in an S3-compatible cloud service (AWS S3, MinIO, Cloudflare R2). You need this module whenever your application deals with files.

## What this module solves

Storing files seems simple until you need to change where they live: in development you want a folder on your machine; in production you want an **object storage** service (services like AWS S3 that store files in a **bucket**, a kind of uniquely-named "folder in the cloud"). Without an abstraction layer, the code ends up full of `fs.writeFile` in one place and AWS SDK calls in another.

This module defines a single contract (`StorageDriver`) with two interchangeable **drivers**: `local` (filesystem) and `s3` (any S3-compatible service). Your code always talks to a **`Disk`** — a named "disk" (e.g. `uploads`, `invoices`) — and switching drivers is just a configuration change, never a code change.

It also solves two important problems in SaaS applications: **tenant isolation** (each customer/organization only sees its own files, automatically stored under `tenants/<id>/…`) and **temporary signed URLs** (download links that expire — e.g. "this link to the PDF is valid for 15 minutes" — without making the bucket public). The local driver also blocks *path traversal* (attempts to escape the root folder with `../`).

## Installation

```bash
pnpm add @basaltkit/storage
```

Depends on `@basaltkit/core` and already includes the AWS SDK (`@aws-sdk/client-s3`) — you don't need to install anything else, even if you only use the local driver.

## Getting started in 5 minutes

1. **Register the plugin** with at least one disk. Start with the `local` driver, which only needs a folder.
2. **Get `Storage`** via the `STORAGE` token and pick a disk.
3. **Store and read files.**

```ts
import { createApp } from '@basaltkit/core'
import { STORAGE, storagePlugin } from '@basaltkit/storage'

// 1. A disk called 'uploads', stored in the project's ./storage folder
const app = await createApp({
  plugins: [
    storagePlugin({
      default: 'uploads',
      disks: {
        uploads: { driver: 'local', root: './storage' },
      },
    }),
  ],
}).boot()

// 2. Get the storage service and the default disk
const storage = app.container.get(STORAGE)
const disk = storage.disk() // 'uploads', because it's the default

// 3. Write, read, check and delete
await disk.put('docs/welcome.txt', 'Hello!')
const content = await disk.get('docs/welcome.txt') // Buffer
console.log(content.toString())                      // 'Hello!'
console.log(await disk.exists('docs/welcome.txt'))   // true
await disk.delete('docs/welcome.txt')

await app.shutdown()
```

For production with S3/MinIO, just change the disk's configuration:

```ts
storagePlugin({
  default: 'uploads',
  disks: {
    uploads: s3Disk({
      bucket: 'my-app',
      region: 'eu-west-1',
      // For MinIO or another S3-compatible service:
      // endpoint: 'http://localhost:9000',
      credentials: { accessKeyId: '…', secretAccessKey: '…' },
    }),
  },
})
```

## Usage guide

### Writing and reading files

```ts
import { Disk, LocalStorageDriver } from '@basaltkit/storage'

const disk = new Disk('uploads', new LocalStorageDriver({ root: './storage' }), { scope: null })

// Accepts strings and Buffers; intermediate folders are created automatically
await disk.put('docs/read-me.txt', 'hello')
await disk.put('img/pixel.bin', Buffer.from([1, 2, 3]))

// On the S3 driver you can specify the content type (Content-Type)
await disk.put('report.pdf', pdfBuffer, { contentType: 'application/pdf' })

// get always returns a Buffer (raw bytes); convert to text if needed
const text = (await disk.get('docs/read-me.txt')).toString()
```

### Upload limits (opt-in, per call)

`put()` accepts two facade-enforced guards. They run in `Disk.put`, **before**
the driver is touched, so every driver — local, S3, GCS, Azure, your own — gets
the same behaviour:

```ts
await disk.put('avatar.png', bytes, {
  contentType: 'image/png',
  maxBytes: 2 * 1024 * 1024,                 // → STORAGE_TOO_LARGE above 2 MiB
  allowedContentTypes: ['image/png', 'image/jpeg'], // → STORAGE_CONTENT_TYPE otherwise
})
```

Both are **opt-in and have no default**: this package caps nothing on its own.
The cap is enforced for the `Buffer | string` inputs the driver contract accepts,
whose byte length is known up front.

If you want a size limit that applies by default, use
[`@basaltkit/files`](https://www.npmjs.com/package/@basaltkit/files) on top —
its upload pipeline applies `DEFAULT_MAX_FILE_SIZE` = **25 MiB
(26 214 400 bytes)** when you configure nothing. Requests are separately capped
by your HTTP adapter's body limit.

### Key validation

Every path goes through one guard before scoping, so a key can never escape its
tenant prefix or defeat prefix-based `list()` isolation. Keys that start with
`/` or `\`, contain a `..` segment, or carry NUL/control characters throw
`StorageInvalidKeyError` (`STORAGE_INVALID_KEY`). Ordinary nested keys like
`avatars/123/pic.png` are untouched.

### Listing, checking and deleting

```ts
await disk.put('a/1.txt', 'x')
await disk.put('a/b/2.txt', 'y')

await disk.list('a')          // ['a/1.txt', 'a/b/2.txt'] — recursive, sorted
await disk.list()             // all files on the disk (within the current scope)
await disk.exists('a/1.txt')  // true
await disk.delete('a/1.txt')  // true (existed and was deleted)
await disk.delete('a/1.txt')  // false (no longer existed)
```

### Multiple named disks

You can declare as many disks as you want — for example, public uploads in one bucket and invoices in another:

```ts
import { createApp } from '@basaltkit/core'
import { STORAGE, storagePlugin } from '@basaltkit/storage'

const app = await createApp({
  plugins: [
    storagePlugin({
      default: 'uploads',
      disks: {
        uploads: { driver: 'local', root: './storage/uploads' },
        invoices: s3Disk({ bucket: 'company-invoices', region: 'eu-west-1' }),
      },
    }),
  ],
}).boot()

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', image)                // default disk ('uploads')
await storage.disk('invoices').put('2026/01.pdf', invoice)   // disk by name
```

### Temporary URLs (secure downloads)

A **signed URL** is a link with a cryptographic signature and an expiration — it lets you grant access to a private file without exposing the bucket. Only the `s3` driver supports this feature:

```ts
// Valid for 15 minutes; after that the link stops working
const url = await storage.disk('invoices').temporaryUrl('2026/01.pdf', '15m')
```

The expiration accepts milliseconds or strings like `'500ms'`, `'30s'`, `'15m'`, `'2h'`, `'7d'`. On the `local` driver this call throws `TemporaryUrlUnsupportedError`.

#### Content disposition — attachment by default

`Disk.temporaryUrl` always passes an **explicit** disposition down to the driver:
`'attachment'` unless you deliberately ask for `'inline'`. The value is pinned
into the signature itself — `ResponseContentDisposition` on S3,
`responseDisposition` on GCS, `contentDisposition` on the Azure SAS — so the
storage origin/CDN cannot be talked out of it.

```ts
// default — the browser downloads the object, it never renders top-level
await disk.temporaryUrl('user-upload.svg', '15m')

// deliberate opt-in — only for content you know is safe to render
await disk.temporaryUrl('brochure.pdf', '15m', { disposition: 'inline' })
```

Why it is fail-closed: a user can upload a file and *declare* it
`text/html` or `image/svg+xml`. Served inline off the bucket origin, that is
stored XSS on the storage domain. `attachment` neutralises it. Embedded uses
(`<img>`, `<video>`) render regardless of disposition, so avatars and media are
unaffected.

### Automatic tenant isolation

Just like the cache, every operation reads the tenant from the request context and prefixes paths with `tenants/<id>/`. Each tenant gets its own private area with no extra code:

```ts
import { runWithContext } from '@basaltkit/core'
import { Disk, LocalStorageDriver } from '@basaltkit/storage'

const disk = new Disk('uploads', new LocalStorageDriver({ root: './storage' }))

await runWithContext({ tenant: { id: 'acme' } }, () => disk.put('logo.png', 'acme-logo'))
await runWithContext({ tenant: { id: 'globex' } }, () => disk.put('logo.png', 'globex-logo'))
await disk.put('logo.png', 'central-logo') // outside any tenant

// Each tenant reads ITS OWN logo.png:
//   acme   → tenants/acme/logo.png
//   globex → tenants/globex/logo.png
//   no tenant → logo.png
```

In normal HTTP requests you don't need `runWithContext` — the framework puts the tenant in the context for you. To disable it, configure the disk with `scope: null`.

### Image processing (resize, WebP, thumbnails)

`disk.image(path)` opens a fluent, engine-agnostic pipeline. Operations are
collected lazily and run only on a terminal (`toBuffer` / `save` / `metadata`).
The result of `save()` goes back through `disk.put`, so tenant scoping, the key
guard, and upload limits all still apply.

The engine (native `sharp`) is **not** bundled here — install the opt-in
[`@basaltkit/image-sharp`](https://www.npmjs.com/package/@basaltkit/image-sharp)
satellite so apps that never touch images carry no native dependency:

```bash
pnpm add @basaltkit/image-sharp sharp
```

```ts
import { storagePlugin } from '@basaltkit/storage'
import { SharpImageProcessor } from '@basaltkit/image-sharp'

storagePlugin({
  imageProcessor: new SharpImageProcessor(),
  disks: { uploads: { driver: 'local', root: './storage' } },
})
```

```ts
// resize + re-encode + write back (content type inferred from the format)
await storage.disk('uploads')
  .image('avatars/1.png')
  .resize(256, 256, { fit: 'cover' })
  .webp(80)
  .save('avatars/1.webp')

const thumb = await storage.disk('uploads').image('hero.jpg').resize(320).jpeg().toBuffer()
const { width, height } = await storage.disk('uploads').image('hero.jpg').metadata()
```

Chainable ops: `.resize(w?, h?, { fit?, position? })`, `.rotate(deg?)`,
`.blur(sigma?)`, `.grayscale()`, `.flip()`, `.flop()`, and the encoders
`.webp(q?)` / `.jpeg(q?)` / `.png(q?)` / `.avif(q?)`. Without an `imageProcessor`
configured, the terminal throws `ImageProcessingUnavailableError`. Run heavy work
inside a `@basaltkit/queue` job to keep it off the request path.

## API reference

### `class Disk`

`new Disk(name: string, driver: StorageDriver, options?: DiskOptions)`

| Method | Signature | Description |
|---|---|---|
| `put` | `put(path: string, content: Buffer \| string, options?: PutOptions): Promise<void>` | Writes a file (creates intermediate folders). |
| `get` | `get(path: string): Promise<Buffer>` | Reads a file; throws `StorageFileNotFoundError` if it doesn't exist. |
| `exists` | `exists(path: string): Promise<boolean>` | Checks whether the file exists. |
| `delete` | `delete(path: string): Promise<boolean>` | Deletes; `true` if it existed. |
| `list` | `list(prefix?: string): Promise<string[]>` | Lists paths under the prefix (recursive, sorted). Prefix defaults to `''`. |
| `temporaryUrl` | `temporaryUrl(path: string, expiresIn: DurationInput, options?: TemporaryUrlOptions): Promise<string>` | Pre-signed URL, served `attachment` unless `{ disposition: 'inline' }`; throws `TemporaryUrlUnsupportedError` if the driver doesn't support it. |
| `image` | `image(path: string): ImagePipeline` | Opens the lazy image pipeline for `path`. |

#### `DiskOptions`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `scope` | `(() => string \| undefined) \| null` | No | reads `ctx().tenant.id` → `tenants/<id>` | Dynamic path prefix, resolved on each operation. `null` disables it. |

#### `PutOptions`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `contentType` | `string` | — | Content type stored with the object (S3/GCS/Azure; ignored by `local`). Also what `allowedContentTypes` is checked against. |
| `maxBytes` | `number` | — (uncapped) | Facade-enforced upload cap. Over it → `STORAGE_TOO_LARGE`, before the driver runs. Opt-in — set it on user-supplied content. |
| `allowedContentTypes` | `readonly string[]` | — (anything) | Facade-enforced allowlist. A missing or unlisted `contentType` → `STORAGE_CONTENT_TYPE`. Exact matches only, no wildcards (use `@basaltkit/files` for `image/*`). |

#### `TemporaryUrlOptions`

| Option | Type | Default | Purpose |
|---|---|---|---|
| `disposition` | `'attachment' \| 'inline'` | `'attachment'` | How the signed URL serves the object. Leave it alone for user-uploaded content; `'inline'` only when top-level rendering is deliberate. |

### `class Storage`

`new Storage(defaultDisk?: string)`

| Method | Signature | Description |
|---|---|---|
| `add` | `add(disk: Disk): this` | Registers a disk (chainable). |
| `disk` | `disk(name?: string): Disk` | Returns the disk by name; with no argument returns the default (or the first registered one). Throws `UnknownDiskError` if it doesn't exist. |

### `storagePlugin(options: StoragePluginOptions)`

Registers `Storage` in the container under the `STORAGE` token and disconnects all drivers on `shutdown`.

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `disks` | `Record<string, DiskConfig>` | Yes | — | Map of disk name → configuration. |
| `default` | `string` | No | first registered disk | Disk returned by `storage.disk()` with no argument. |
| `imageProcessor` | `ImageProcessor` | No | — | Engine shared by every disk's `.image(...)` pipeline. Pass `new SharpImageProcessor()` from `@basaltkit/image-sharp`; without it the pipeline terminals throw `ImageProcessingUnavailableError`. |

#### `DiskConfig`

One of three forms (all also accept `scope` from `DiskOptions`):

- `{ driver: 'local', root: string }` — `root` is the root folder on the filesystem.
- `s3Disk({ ...S3DriverOptions })` from [`@basaltkit/storage-s3`](https://www.npmjs.com/package/@basaltkit/storage-s3) — see below.
- `{ driver: <a StorageDriver instance> }` — any custom driver, e.g.
  `@basaltkit/storage-gcs` or `@basaltkit/storage-azure`.

### `STORAGE`

Dependency injection token: `app.container.get(STORAGE)` returns the `Storage`.

### `class S3StorageDriver` (Advanced)

`new S3StorageDriver(options: S3DriverOptions)` — works with AWS S3, MinIO, Cloudflare R2 and other compatible services.

#### `S3DriverOptions`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `bucket` | `string` | Yes | — | Bucket name. |
| `region` | `string` | No | `'us-east-1'` | AWS region. |
| `endpoint` | `string` | No | — | Custom endpoint — set this to use MinIO/R2. |
| `credentials` | `{ accessKeyId: string; secretAccessKey: string }` | No | credentials from the AWS environment | Explicit credentials. |
| `forcePathStyle` | `boolean` | No | `true` when there's an `endpoint`, otherwise `false` | URLs in the form `http://host/bucket/key` (required by MinIO). |

### `class LocalStorageDriver` (Advanced)

`new LocalStorageDriver(options: { root: string })` — stores on the filesystem, with `root` resolved to an absolute path. Rejects paths that try to escape the root (throws `StorageInvalidPathError`). Doesn't support `temporaryUrl`.

### `interface StorageDriver` (Advanced)

Contract for building your own driver: `name` (readable string, used in errors), `put`, `get`, `exists`, `delete`, `list`, `temporaryUrl?` (optional, receives the expiration in milliseconds) and `disconnect`.

### Errors

| Error | Code | HTTP | When |
|---|---|---|---|
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | 500 | `get()` on a path that doesn't exist. |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | 500 | The `local` driver resolved a path outside its `root` (`../…`). |
| `StorageInvalidKeyError` | `STORAGE_INVALID_KEY` | 500 | The key starts with `/` or `\`, has a `..` segment, or contains NUL/control characters. Checked for every driver. |
| `StorageTooLargeError` | `STORAGE_TOO_LARGE` | 500 | `put()` content exceeds the `maxBytes` you passed. |
| `StorageContentTypeError` | `STORAGE_CONTENT_TYPE` | 500 | `put()` `contentType` is missing from, or absent in, `allowedContentTypes`. |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | 500 | `storage.disk('name')` for a disk that isn't declared. |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | 500 | `temporaryUrl()` on a driver without support (e.g. `local`). |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | 500 | An image-pipeline terminal ran with no `imageProcessor` configured. |

All extend `BasaltError` from `@basaltkit/core` and carry the `code` above.

None of them declare an HTTP `status`, so the adapters' shared error mapper
turns them into a generic **500 `INTERNAL_ERROR`** with the message withheld —
storage failures are not a client-facing contract. Catch them in your handler
and translate deliberately (a missing file is usually your 404, a rejected
upload usually your 413/415). `@basaltkit/files` already does this: its
equivalents carry 413/415/402/404/400.

### Hooks & events

`@basaltkit/storage` emits **no hooks** — it is a passive I/O layer. The upload
lifecycle events (`file:uploaded`, `file:deleted`, `file:scanned`) live in
[`@basaltkit/files`](https://www.npmjs.com/package/@basaltkit/files), which is
built on top of this package.

## Common errors and solutions (FAQ)

**`get` throws `STORAGE_FILE_NOT_FOUND` but I just saved the file.**
You most likely wrote and read in different tenant contexts: with the default scope, the same `logo.png` lives at `tenants/acme/logo.png` for one tenant and at `logo.png` outside any tenant. Check the context or use `scope: null`.

**`STORAGE_INVALID_PATH` when using `../` in the path.**
This is intentional: the local driver blocks any path that escapes the root folder — it's a security protection against *path traversal*. Always use relative paths within the disk.

**`Unknown disk "x"` when calling `storage.disk('x')`.**
The disk must be declared in `storagePlugin({ disks: { x: … } })`. Check the name (it's case-sensitive).

**`temporaryUrl` fails with "does not support temporary URLs".**
The `local` driver can't generate signed URLs — that's an S3 feature. In development, serve files through a route in your application, or use MinIO locally with an `s3` disk.

**With MinIO I get connection or bucket errors.**
Set `endpoint: 'http://localhost:9000'` (or your address). `forcePathStyle` automatically becomes `true` when there's an endpoint — you don't need to set it. Confirm the bucket already exists in MinIO.

**`get` returns a `Buffer`, I wanted text/JSON.**
A `Buffer` is raw bytes. Convert it: `buffer.toString()` for text, `JSON.parse(buffer.toString())` for JSON.

## How it connects to other modules

- **`@basaltkit/core`** — provides `createApp`, the container, the request context (from which tenant isolation comes), `parseDuration` for expirations, and the `BasaltError` base class.
- **`@basaltkit/tenancy`** — with the tenancy plugin identifying each request's tenant, disks isolate files per tenant automatically.
- **`@basaltkit/http` / `@basaltkit/express` / `@basaltkit/fastify` / `@basaltkit/hono`** — in upload/download routes, get `Storage` from the container and use `disk.put`/`disk.get`/`disk.temporaryUrl`.
- **`@basaltkit/prisma`** — a common pattern: store the file on a disk and its path/metadata in the database.

Guides: [Storage](/guide/storage) · [Files & uploads](/guide/files) · [Tenancy](/guide/tenancy).
