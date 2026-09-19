# @basaltkit/files

## 4.2.0

### Minor Changes

- 7363b76: Streaming storage: `putStream` / `getStream` / `copy` / `stat`, plus a signing-endpoint override for pre-signed URLs (BK-019, BK-005 phase 2).
  
  **`@basaltkit/storage`** — four new optional driver capabilities on the `Disk` facade, with the same safety rules as `put` (key validation, tenant scope prefix, fail-closed without a tenant, `maxBytes` / `allowedContentTypes`):
  
  - `disk.putStream(key, source, { contentType, contentLength?, maxBytes?, allowedContentTypes? })` — `source` is a Node `Readable`, a web `ReadableStream` or any `AsyncIterable<Uint8Array | string>`. The facade normalizes it into one Node `Readable` that enforces `maxBytes` **while it streams**: past the cap the upload aborts with `StorageTooLargeError` and the source is destroyed (Node) or cancelled (web). `contentType` and a declared `contentLength` over `maxBytes` are refused before a byte is read.
  - `disk.getStream(key)` — a Node `Readable`; the caller must consume or `destroy()` it. A missing object throws the existing `StorageFileNotFoundError`.
  - `disk.copy(from, to, { disk?, contentType?, maxBytes?, requireServerSide? })` — server-side within one driver; otherwise `getStream` → `putStream`, then `get` → `put`. Both keys are validated and scoped, the destination against the destination disk. `requireServerSide: true` turns a fallback into `CopyUnsupportedError`.
  - `disk.stat(key)` — `{ size, contentType?, etag?, lastModified? }`.
  - `disk.supports('putStream' | 'getStream' | 'copy' | 'stat' | 'temporaryUrl' | 'temporaryUploadUrl')` so callers can branch instead of catching.
  - New errors: `PutStreamUnsupportedError` (`STORAGE_PUT_STREAM_UNSUPPORTED`), `GetStreamUnsupportedError` (`STORAGE_GET_STREAM_UNSUPPORTED`), `CopyUnsupportedError` (`STORAGE_COPY_UNSUPPORTED`), `StatUnsupportedError` (`STORAGE_STAT_UNSUPPORTED`), `StorageStreamLengthRequiredError` (400 `STORAGE_STREAM_LENGTH_REQUIRED`), `StorageSigningEndpointInvalidError` (400 `STORAGE_SIGNING_ENDPOINT_INVALID`). New exports: `StreamSource`, `PutStreamOptions`, `PutStreamInput`, `CopyOptions`, `CopyDriverOptions`, `StorageStat`, `toLimitedReadable`, `collectStream`. `LocalStorageDriver` implements all four (fs streams, `fs.copyFile`, `fs.stat`), removing a partial file when a streaming upload fails.
  - `temporaryUrl` / `temporaryUploadUrl` accept an `endpoint` override, validated at the facade (absolute `http(s)`, no credentials, no query/fragment). A driver that cannot sign for another endpoint must refuse it rather than ignore it.
  
  **`@basaltkit/storage-s3`** — `putStream` (PutObject: streams through with a known `contentLength`, buffers up to `maxBytes` without one, else `STORAGE_STREAM_LENGTH_REQUIRED`; `@aws-sdk/lib-storage` is deliberately not added as a dependency), `getStream` (GetObject body, web-stream bodies wrapped), `copy` (CopyObject, SSE re-applied, `MetadataDirective: 'REPLACE'` with a content type) and `stat` (HeadObject). New `signingEndpoint` driver option and per-call `endpoint`: pre-signed URLs are signed for another host of the same bucket — an internal MinIO name, a CDN alias — keeping region, path style, credentials, SSE and the signed content-type/length/checksum headers unchanged.
  
  **`@basaltkit/storage-azure`** — `putStream` (`uploadStream`, any length), `getStream` (`download()`), `copy` (`syncCopyFromURL` through a 5-minute read-only SAS; Azure caps it at 256 MiB) and `stat` (`getProperties`). An `endpoint` override is refused with the unsupported error: a SAS is derived from the blob client's account host.
  
  **`@basaltkit/storage-gcs`** — `putStream` (`createWriteStream`, any length), `getStream` (`createReadStream`; a missing object surfaces as `STORAGE_FILE_NOT_FOUND` on the stream), `copy` (`file.copy`) and `stat` (`getMetadata`, string size coerced). An `endpoint` override is refused: V4 signatures are bound to the bucket host.
  
  **`@basaltkit/files`** — `upload()` now streams straight to the backend when the driver supports `putStream`, keeping `maxSize`, the SHA-256 and BK-003 sniffing (the first 64 KiB are read to decide the type, then the body continues streaming); the built-in `maxTotalBytes` quota becomes a second mid-stream limit. The buffered path stays as the fallback (no `putStream`, an unbounded `maxSize` with no declared length, or a custom `checkQuota`, which needs the size up front), so existing `Buffer` callers are unaffected. A failed streaming upload deletes whatever reached the disk. New `UploadInput.contentLength` (the client's declared size — a hint that lets S3 stream instead of buffer; the real size is always measured) and new `files.downloadStream(id, tenantId?, { bypassQuarantine? })`, mirroring `download()` including the BK-004 quarantine gate.
  
  **`@basaltkit/backup`** — dumps are no longer buffered: `create()` measures and hashes the temporary `pg_dump` file in chunks and streams it to the disk with a known `contentLength`; `restore()` streams the artifact to a temporary file and still verifies its SHA-256 before `pg_restore` runs. Disks whose driver cannot stream keep the previous whole-file behaviour.

### Patch Changes

- Updated dependencies [7363b76]
- Updated dependencies [7363b76]
  - @basaltkit/core@1.4.0
  - @basaltkit/http@2.3.0
  - @basaltkit/storage@3.2.0

## 4.1.0

### Minor Changes

- b0cc59f: Content sniffing, scan quarantine and streaming uploads (BK-003, BK-004, BK-006).
  
  - `validate.sniff: true | ((bytes: Uint8Array) => string | null)` (opt-in, default off — consider enabling it): the real type is read from the magic bytes by a built-in, dependency-free signature table (PDF, PNG, JPEG, GIF, WebP, TIFF both byte orders, ZIP, docx/xlsx/pptx, plus HTML/SVG/XML text and PE/ELF/Mach-O/`#!` executables to catch disguises). Content that contradicts the declared type — or a declared signature type whose bytes don't carry it (renamed/truncated files) — is refused with `FileTypeMismatchError` (`415 FILE_TYPE_MISMATCH`). `allowedTypes` then judges the detected type, `FileRecord.contentType` is the detected type, and the client's claim is kept in `metadata.declaredType`. `sniffContentType` and `normalizeContentType` are exported.
  - `requireScan: true` (on `filesPlugin` / `Files`, default off): `download()` and `temporaryUrl()` — and so `POST /files/:id/url` on every adapter — throw `FileNotScannedError` (`423 FILE_NOT_SCANNED`) until `markScanned` reports the file clean, and `FileInfectedError` (`403 FILE_INFECTED`) after a failed scan. A scan timestamp without a clean verdict fails closed. Listing is unaffected. The scanner reads quarantined bytes with `download(id, tenantId, { bypassQuarantine: true })`.
  - `upload()` accepts a stream — Node `Readable`, `AsyncIterable<Uint8Array>` or web `ReadableStream` — besides a `Buffer`/`Uint8Array`. `maxSize` is enforced while the stream arrives (the source is destroyed/cancelled past the cap, nothing is written), the size and SHA-256 are computed on the fly, and sniffing runs on the first 64 KiB. Since the storage `Disk.put` contract takes whole buffers, accepted bytes (at most `maxSize`) are buffered before the write.
  - `markScanned` now stamps `scannedAt` with the injectable `now` clock instead of `Date.now()`.

### Patch Changes

- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
- Updated dependencies [b0cc59f]
  - @basaltkit/core@1.3.2
  - @basaltkit/http@2.2.0
  - @basaltkit/storage@3.1.0

## 4.0.0

### Major Changes

- fb85c40: Security hardening (deep audit 2026-09, batch B07).
  
  - `@basaltkit/files`: `fileRoutes()` now enforces object-level authorization — owner-only (`uploadedBy === ctx().user.id`) by default, with `authorize(action, record, user)` and `shared: true` as explicit options; files the caller may not reach answer 404 (including `DELETE`). `POST /files/:id/url` validates `expiresIn` (positive, at most `maxUrlTtl`, default `1h`) and answers 400 otherwise. The `maxTotalBytes` quota is serialised per tenant and re-checked after insert, so concurrent uploads can no longer exceed it. `MemoryFileStore` uses tuple-safe keys.
  - `@basaltkit/comments`: bodies are capped (`maxBodyLength`, default 10 000 characters) and mentions per comment are capped (`maxMentions`, default 50); new `resolveMentions(ids, tenantId)` option filters who can be mentioned. `commentRoutes({ authorize })` adds a per-resource authorization hook; by default resolve/reopen are restricted to the comment's author, like edit/delete. `MemoryCommentStore` uses tuple-safe keys.
  - `@basaltkit/audit-viewer`: `auditViewerRoutes()` requires an authorization guard via `meta` (e.g. `{ can: 'audit:read' }`) merged into every route, and throws `AuditViewerUnguardedError` without one unless `allowAnyAuthenticated: true` is passed explicitly.
  - `@basaltkit/files`, `@basaltkit/comments`, `@basaltkit/audit-viewer`, `@basaltkit/search`: inside a tenant context an explicit `tenantId` argument must match the context tenant (it can no longer widen a call to another tenant); a mismatch throws a `*_TENANT_MISMATCH` error (403). `search.reindex()` still trusts the tenant each sync rule maps.

### Patch Changes

- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/storage@3.0.0
  - @basaltkit/http@2.1.0

## 3.1.0

### Minor Changes

- 6c9f1c7: `files-versions` reads the ambient tenant, like `Files` always did.
  
  `FileVersions` resolved its store key as `tenantId ?? SINGLE_TENANT_SCOPE`,
  skipping the request context. `Files.upload` does read the context, so the two
  disagreed: a multi-tenant application that passed no explicit `tenantId` — the
  normal case — wrote versions under `acme` and read them back under `'default'`.
  `history()` returned `[]` and `latest()` returned `null` for a document that
  existed, and `download()` raised `FileVersionNotFoundError` for a file sitting
  on the disk.
  
  A silent wrong answer, which is worse than the error it replaced, and precisely
  the failure this package was written to prevent. Its own README described the
  correct behaviour, not the implemented one.
  
  The rule now lives in one place. `@basaltkit/files` exports `fileScope()` and
  `resolveFileTenant()`, `Files` uses them internally, and `FileVersions` takes
  the same `tenancyActive` probe — wired by `fileVersionsPlugin` from the same
  `'tenancy:active'` marker `filesPlugin` reads. Two implementations of one rule
  is one too many.
  
  Single-tenant applications are unaffected: with no tenancy registered there is
  no tenant to resolve and the scope stays `SINGLE_TENANT_SCOPE`. That path is now
  exercised by the `beyond-saas` tripwire, which covered `files` but not
  `files-versions` — which is why this shipped.
  
  ---
  
  **`@basaltkit/activity` adopts the safe scope when tenancy is present.**
  
  `tenantScoped` defaulted to `true`, meaning "scope to the context tenant, and
  run **unscoped** when there is none". In a multi-tenant application a feed query
  made outside a tenant context therefore answered with every tenant's records —
  and an activity line is not an aggregate number, it reads "Dr. Kiala opened
  matter 2026/014 for Kwanza Lda": another firm's client, by name, in prose.
  
  `activityPlugin` now tightens to `'required'` when `@basaltkit/tenancy` is
  registered and the application expressed no preference — the same thing
  `@basaltkit/cache` already does, and what the framework's own rule asks for: a
  generic package never requires tenancy, but adopts safe defaults when it is
  there. A single-tenant app is untouched, and `tenantScoped: false` still wins
  for an operator console that means to read across tenants.

## 3.0.0

### Major Changes

- 30abb78: `@basaltkit/files-prisma`: the file domain finally has a durable store.
  
  Debuts at **0.1.0**, not 1.0.0. The eleven sibling `-prisma` packages are at 1.x
  and covered by the ecosystem's semver commitment; this one has not been run
  against a real database by anyone yet, and saying so in the version number is
  cheaper than saying it in a changelog nobody reads.
  
  Of the framework's domains, eleven ship both `-prisma` and `-sqlite` backends
  without a single exception. `files` shipped neither. It was the only domain with
  a store contract and no durable implementation of it, and its default was
  `MemoryFileStore`.
  
  For a cache or a queue, an in-memory default is a fair trade — it loses work
  that can be redone. Here it loses something else. The bytes go to the disk under
  a key like `files/6f2c…`, and that key lives only in the file record. Lose the
  record and the bytes stay in the bucket forever: unreferenced, unlistable,
  unmatchable to the document they were. The application reports an empty file
  list, and nothing errors anywhere.
  
  ```ts
  import { prismaFilesStore } from '@basaltkit/files-prisma'
  
  filesPlugin({ disk, store: prismaFilesStore(prisma).store })
  ```
  
  `totalSize` sums in the database rather than listing rows and adding up in JS: a
  quota check runs on every upload, and a tenant with fifty thousand files should
  not move fifty thousand rows to learn one number.
  
  **Two changes to the `@basaltkit/files` contract**, both breaking:
  
  - **`scanned?: boolean` is now `scannedAt?: number`.** The date derives the
    boolean and the boolean does not derive the date, and "scanned" with no idea
    when stops being an answer the moment the scanner's rules change — which is
    the one thing antivirus rules reliably do. `markScanned()` stamps it; the
    `file:scanned` hook keeps its name, because the event is not the field.
  - **`metadata` is now `FileMetadata`** — a `Record<string, JsonValue>` rather
    than `Record<string, unknown>`. Every durable store would otherwise have had
    to cast its way past its driver's own JSON type, a cast each implementation
    repeats and has to get right. Saying what the column actually holds costs
    nothing at the call site: an object literal of strings, numbers and nested
    objects already satisfies it.
  
  `@basaltkit/prisma` adds `files` to the domains `prisma:sync` discovers, so the
  model is merged into your schema like every other one.

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.2.1

### Patch Changes

- Updated dependencies [e19b765]
  - @basaltkit/storage@2.0.0

## 1.2.0

### Minor Changes

- f3703a1: Files works in apps without tenancy.
  
  Every operation — `upload`, `get`, `list`, `download`, `temporaryUrl`, `delete`, `markScanned` — resolved a tenant and threw `FileTenantRequiredError` (`400 FILE_TENANT_REQUIRED`) when it couldn't. In an app with no `tenancyPlugin` that is always, making the package unusable outside multi-tenant SaaS.
  
  `filesPlugin` now reads tenancy's `tenancy:active` metadata marker (a signal, not an import) and fails closed only when tenancy is registered — unchanged for multi-tenant apps. Without tenancy, records are filed under the exported `SINGLE_TENANT_SCOPE` (`'default'`) and storage operations are **not** wrapped in a synthesized tenant context, so disk paths stay unprefixed and identical to using `@basaltkit/storage` directly. `new Files(options, tenancyActive?)` takes an optional second argument.

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1
  - @basaltkit/storage@1.3.1

## 1.1.0

### Minor Changes

- 8a3e92a: **Security: signed download URLs default to `Content-Disposition: attachment`; uploads get a default size cap.**
  
  **What was exposed.** Uploads trusted the client's declared Content-Type end-to-end and `temporaryUrl` presigned bare GET URLs, so an uploaded `text/html`/`image/svg+xml` object rendered top-level on the storage/CDN origin — stored XSS when that origin is CNAME'd onto the app domain. `Files` validation also defaulted to open (no size cap).
  
  **What changed.** `Disk.temporaryUrl` (and the S3/Azure/GCS drivers) now pin `Content-Disposition: attachment` on every signed URL by default; top-level inline rendering is a deliberate opt-in — `temporaryUrl(path, expiresIn, { disposition: 'inline' })` (also threaded through `Files.temporaryUrl`). Embedded uses (`<img>`, `<video>`) are unaffected by disposition, so avatars/previews inside pages keep working. `Files` uploads are capped at 25 MiB by default (`DEFAULT_MAX_FILE_SIZE`, new export) when no `validate.maxSize` is configured — raise or override explicitly. A MIME denylist was deliberately **not** added: the disposition pin closes the render-time vector at the right layer without breaking legitimate HTML/SVG storage. Custom `StorageDriver` implementations: `temporaryUrl` gains an optional third parameter (`TemporaryUrlOptions`, new export) — implementations that ignore it keep compiling but should honor it.

### Patch Changes

- Updated dependencies [8a3e92a]
- Updated dependencies [8a3e92a]
  - @basaltkit/core@1.3.0
  - @basaltkit/storage@1.3.0

## 1.0.2

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- Updated dependencies [be55f2d]
  - @basaltkit/storage@0.24.0
  - @basaltkit/core@0.24.0
  - @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0
- @basaltkit/storage@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0
- @basaltkit/storage@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0
- @basaltkit/storage@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0
- @basaltkit/storage@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0
- @basaltkit/storage@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0
- @basaltkit/storage@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0
- @basaltkit/storage@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0
- @basaltkit/storage@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/fastify@0.15.0
- @basaltkit/storage@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/fastify@0.14.0
- @basaltkit/storage@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/fastify@0.13.0
- @basaltkit/storage@0.13.0

## 0.12.0

### Minor Changes

- 74107c7: New package: `@basaltkit/files` — an upload pipeline over `@basaltkit/storage`.

  `Files.upload(buffer, input)` validates content type and size, enforces a per-tenant storage quota (a built-in `maxTotalBytes` and/or a custom `checkQuota` hook for wiring `@basaltkit/subscriptions`), writes the bytes tenant-scoped, records metadata (name, size, SHA-256 checksum, uploader), and emits `file:uploaded`. Also `download`, `temporaryUrl` (signed), `get`/`list`, `delete` (emits `file:deleted`), and `markScanned` (emits `file:scanned`) for out-of-band antivirus/thumbnail steps. Storage access runs in the resolved tenant's context so files stay isolated even from a background job. `filesPlugin({ disk, validate, maxTotalBytes, checkQuota, store })` registers the service; `fileRoutes()` exposes list/metadata/signed-URL/delete (uploading is multipart, so it's called from your own handler). `FileStore` (with `MemoryFileStore`) persists metadata. Fully unit-tested with a fake storage driver.

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/fastify@0.12.0
- @basaltkit/storage@0.12.0
