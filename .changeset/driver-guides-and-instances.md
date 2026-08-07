---
'@machize/cache': minor
'@machize/storage': minor
---

`cachePlugin` and `storagePlugin` now accept a custom driver **instance**, not just a built-in shortcut.

- `cachePlugin({ driver })` accepts `'memory'`, `'redis'`, **or a `CacheDriver` instance** — so `@machize/cache-tiered` (and any custom driver) plugs in directly.
- A disk in `storagePlugin({ disks })` accepts `{ driver: 'local'|'s3', … }` **or `{ driver: <StorageDriver instance> }`** — so `@machize/storage-gcs`, `@machize/storage-azure` and custom drivers plug in directly.

Both changes are backward compatible (the string shortcuts still work).
