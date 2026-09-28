---
'@basaltkit/storage': major
---

Framework audit residual: non-canonical keys are refused on every driver.

A key with a `.` segment or an empty segment — `a/./b`, `./a`, `a//b`, a trailing `/`, `''` — now throws `StorageInvalidKeyError` (`STORAGE_INVALID_KEY`) on every `Disk` operation. The local driver resolved these to the same file as `a/b`, while S3/GCS/Azure stored distinct objects, so one key string could name one file on one backend and several on another. They are **rejected, not normalized**: a silent rewrite would let two strings an app compares (allow-lists, dedupe, audit trails) address the same object. A `list()` prefix may still be `''` (the disk root) or end with one `/` (`list('avatars/')`). Dotfiles and dotted names (`.env`, `a/..b`, `a.b.c`) are unaffected.

**Why major:** keys that used to be accepted now throw. Migration: build keys with `parts.join('/')` from non-empty parts; objects already written on S3/GCS/Azure under such keys are unreachable through `Disk` — copy them to canonical keys with the provider's SDK.
