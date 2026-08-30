# @basaltkit/storage

## 1.3.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/core@1.3.1

## 1.3.0

### Minor Changes

- 8a3e92a: **Security: signed download URLs default to `Content-Disposition: attachment`; uploads get a default size cap.**
  
  **What was exposed.** Uploads trusted the client's declared Content-Type end-to-end and `temporaryUrl` presigned bare GET URLs, so an uploaded `text/html`/`image/svg+xml` object rendered top-level on the storage/CDN origin — stored XSS when that origin is CNAME'd onto the app domain. `Files` validation also defaulted to open (no size cap).
  
  **What changed.** `Disk.temporaryUrl` (and the S3/Azure/GCS drivers) now pin `Content-Disposition: attachment` on every signed URL by default; top-level inline rendering is a deliberate opt-in — `temporaryUrl(path, expiresIn, { disposition: 'inline' })` (also threaded through `Files.temporaryUrl`). Embedded uses (`<img>`, `<video>`) are unaffected by disposition, so avatars/previews inside pages keep working. `Files` uploads are capped at 25 MiB by default (`DEFAULT_MAX_FILE_SIZE`, new export) when no `validate.maxSize` is configured — raise or override explicitly. A MIME denylist was deliberately **not** added: the disposition pin closes the render-time vector at the right layer without breaking legitimate HTML/SVG storage. Custom `StorageDriver` implementations: `temporaryUrl` gains an optional third parameter (`TemporaryUrlOptions`, new export) — implementations that ignore it keep compiling but should honor it.

### Patch Changes

- Updated dependencies [8a3e92a]
  - @basaltkit/core@1.3.0

## 1.2.0

### Minor Changes

- 5b70550: Add image processing via a fluent, engine-neutral pipeline.

  - **`disk.image(path)`** returns an `ImagePipeline`: `.resize(w?, h?, { fit?, position? })`, `.rotate()`, `.blur()`, `.grayscale()`, `.flip()`, `.flop()`, and encoders `.webp()/.jpeg()/.png()/.avif()`, with terminals `.toBuffer()`, `.metadata()`, and `.save(path)`. `save()` delegates to `disk.put`, so tenant scope, the key guard, and upload limits all apply; the content type is inferred from the output format.
  - **`ImageProcessor`** contract + `ImageOp`/`ImageFormat`/`ImageMetadata`/`ResizeOptions` types. The engine is injected via `storagePlugin({ imageProcessor })` — the new `@basaltkit/image-sharp` satellite provides a `sharp`-backed one, keeping the native binary out of the storage core.
  - New `ImageProcessingUnavailableError` (`STORAGE_IMAGE_UNAVAILABLE`) when a pipeline terminal runs with no engine configured.

## 1.1.0

### Minor Changes

- Facade-level object-key validation across every driver (`STORAGE_INVALID_KEY` for leading-slash/`..`/control chars) and opt-in `maxBytes` / `allowedContentTypes` upload limits on `put()`.

## 1.0.1

### Patch Changes

- **SECURITY: path-traversal fix on the tenant-scoping seam.** `Disk` now rejects
  keys containing `..` segments or an absolute path before applying the tenant
  prefix, so a caller-supplied key can no longer `../` its way out of
  `tenants/<id>/…` into another tenant's objects (the local driver only guarded
  the disk root, not the tenant scope). Data methods are now async so an invalid
  path surfaces as a rejected promise.

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

### Minor Changes

- be55f2d: `cachePlugin` and `storagePlugin` now accept a custom driver **instance**, not just a built-in shortcut.

  - `cachePlugin({ driver })` accepts `'memory'`, `'redis'`, **or a `CacheDriver` instance** — so `@basaltkit/cache-tiered` (and any custom driver) plugs in directly.
  - A disk in `storagePlugin({ disks })` accepts `{ driver: 'local'|'s3', … }` **or `{ driver: <StorageDriver instance> }`** — so `@basaltkit/storage-gcs`, `@basaltkit/storage-azure` and custom drivers plug in directly.

  Both changes are backward compatible (the string shortcuts still work).

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/core@0.5.1

## 0.5.0

### Patch Changes

- @basaltkit/core@0.5.0

## 0.4.0

### Patch Changes

- @basaltkit/core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [8a0ccbc]
- Updated dependencies [7b92e25]
  - @basaltkit/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
