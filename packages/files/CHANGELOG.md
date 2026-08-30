# @basaltkit/files

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
