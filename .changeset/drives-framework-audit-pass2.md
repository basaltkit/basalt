---
'@basaltkit/drives': minor
'@basaltkit/drives-google': major
'@basaltkit/drives-microsoft': major
'@basaltkit/drives-dropbox': major
---

Framework audit, pass 2, section E (FA-072..FA-076): drives hardening.

**`@basaltkit/drives` (0.x — minor is the breaking slot)**

- **Signed listing cursors (FA-072/FA-073).** `listItems()` now returns `bkl1.<adapter cursor>.<mac>`, MAC-bound (key derived from `secret`) to the tenant and connection, and refuses any other cursor with `DRIVE_ACCESS_DENIED` before the adapter sees it. A Graph cursor is a URL fetched with the connection's bearer token, so a caller-authored one could read another drive. *Migration:* pass cursors back unchanged; a cursor issued before the upgrade or under a rotated `secret` must be dropped (list again from the start). Stored sync cursors are unaffected.
- **Refresh race (FA-074).** A worker told `invalid_grant` now invalidates only by compare-and-set, and only if the row still holds the rejected refresh token (otherwise it adopts the newer credentials); a winner that finds itself invalidated by such a loser restores the connection with its fresh tokens. No API change.
- **Per-provider replay keys (FA-075).** The replay guard no longer reads `x-goog-message-number` from every provider; it keys on the new optional `DriveNotificationResult.replayKey` or a digest of the raw body. *Migration (custom adapters):* report `replayKey` if your vendor's body does not distinguish deliveries.
- **FA-076.** `DriveSecretBox` pins a 16-byte GCM tag (truncated tags refused) and rejects NUL in the AAD context; watch secrets are stored as a `sha256:` digest (legacy plain rows still match); `timeoutMs` is documented as an inactivity timeout and now also bounds each wait for response headers, with a new opt-in whole-exchange `deadlineMs` (`DrivesOptions`, `DriveFetchOptions`, `GuardedRequestInit`); the OAuth callback echoes only a well-formed `?error=` code; the anonymous notification route answers an unknown provider with `DRIVE_NOTIFICATION_INVALID` instead of listing registered providers.

**Adapters (major: `rootId` confinement now refuses calls that used to succeed)**

- **Root confinement (FA-073).** With a `rootId`, a `folderId`, `getItem`, `download` and an upload target outside the root are refused with `DRIVE_ACCESS_DENIED` (`get` returns `null`). Google walks `parents` (resolving the `root` alias); Microsoft walks `parentReference.id` for an `item:` root (new `ancestryMaxDepth` option); Dropbox compares `path_lower` (lexically for paths, one `get_metadata` for `id:`/`ns:`, the download's `Dropbox-API-Result` before its body is read). *Migration:* a connection that relied on reaching outside its root must be reconnected with a wider root (or none).
- `@basaltkit/drives-google` reports `X-Goog-Message-Number` as `replayKey`. Requires `@basaltkit/drives` ≥ 0.3.
