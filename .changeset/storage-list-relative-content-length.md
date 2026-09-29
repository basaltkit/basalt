---
'@basaltkit/storage': major
---

`Disk.list()` returns scope-relative keys, and `putStream` holds `contentLength` to its word (audit, improvements item 7).

**Breaking — `list()` keys are relative to the disk's scope.** A tenant-scoped disk used to return `tenants/<id>/a/1.txt`, which `get()`/`delete()` then prefixed a second time (`tenants/<id>/tenants/<id>/a/1.txt` — not found). Keys now come back exactly as `put`/`get` take them (`a/1.txt`), on every driver. A central disk (`scope: null`) returns what it did. The prefix is also a directory on every driver now: `list('a')` means `list('a/')`. Object stores (S3, GCS, Azure) match their listing prefix as a plain string, so `list('invoice')` used to return `invoice-2026/…` there but not on `local` — and `list('tenants/acme')` on a central cloud disk also listed tenant `acme2`.

Migration: drop any code that stripped the tenant prefix from listed keys by hand (`key.slice('tenants/acme/'.length)`), and list a real directory instead of relying on a partial-name prefix match on a cloud driver. Custom drivers need no change: `StorageDriver.list(prefix)` still returns full keys and may match as a plain string — the Disk narrows and strips.

**`putStream` validates and verifies `contentLength`.** A value that is not a non-negative safe integer is refused before a byte is read (new `StorageContentLengthInvalidError`, `400 STORAGE_CONTENT_LENGTH_INVALID`). A body that carries more or fewer bytes than declared fails with the new `StorageContentLengthMismatchError` (`400 STORAGE_CONTENT_LENGTH_MISMATCH`) — the moment it passes the declared size, or at its end when it falls short, but always before that end reaches the driver, so S3/GCS/Azure (which commit on end) store nothing and `local` removes its partial file. Before, a wrong `contentLength` reached the backend as-is, so the stored object and the caller's idea of it could disagree. The `copy()` fallback (`getStream` → `putStream`) is verified against the size `stat()` reported. `toLimitedReadable(source, maxBytes?, expectedLength?)` takes the new optional third argument.
