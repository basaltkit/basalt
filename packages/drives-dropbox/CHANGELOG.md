# @basaltkit/drives-dropbox

## 0.1.0

### Initial release

- aff3f6a: Drives phase 2a: the first real provider adapter, and the HTTP routes phase 1 deferred.
  
  **New — `@basaltkit/drives-dropbox` 0.1.0 (unpublished).** The Dropbox adapter:
  OAuth with `token_access_type=offline`, PKCE and refresh/revoke;
  `files/list_folder` + `/continue` cursors for both pagination and the change
  feed; `files/get_metadata`; streaming `files/download` with the `Dropbox-API-Arg`
  header (non-ASCII escaped, because the argument travels in an HTTP header);
  single-shot `files/upload` streamed onto the socket; `content_hash` as a
  clearly-labelled `dropboxContentHash` checksum; rate limiting that honours both
  `Retry-After` and Dropbox's own `retry_after` body hint; the full error taxonomy
  mapped onto the contract; and signed webhook verification (`X-Dropbox-Signature`,
  HMAC-SHA256 over the raw body, constant time) including the `GET ?challenge=`
  handshake that arrives before any connection exists.
  
  **`@basaltkit/drives` — the routes, and seven contract changes the first adapter
  forced.** `driveRoutes()` serves the connect flow and one neutral notification
  endpoint over `route()` from `@basaltkit/http`, parity-tested on Fastify,
  Express and Hono. The contract changes:
  
  - `DriveNotificationResult.accountIds` — Dropbox has no per-connection
    subscription and identifies a connection by provider account id.
  - `DriveNotificationOutcome.connections` is now a **list**: one notification can
    concern several connections.
  - A verified notification that matches nothing is `reason: 'unmatched'` with a
    200, not a 400 — a different answer is an oracle for which accounts a
    deployment holds.
  - `DriveProvider.deltaIncludesExisting` — whether `startDelta`'s cursor replays
    what already exists. Defaults to `false`, so the engine backfills with a
    listing pass first; without it Google Drive's first sync would import nothing.
  - `DriveChange` removals and `DriveRemoval` carry `externalId` **or** `path`:
    a Dropbox deletion has no id at all.
  - `DriveProvider.retryAfterFromBody` — read a vendor rate-limit hint out of a
    429 body, under a hard read bound.
  - `GuardedRequestInit.body` accepts a `Readable`, streamed and never buffered,
    which is what makes `DriveProvider.upload` implementable.
  - `DriveCursorResetError` (`DRIVE_CURSOR_RESET`) — all three vendors can
    invalidate a stored cursor, and the cursor is persisted, so without a way to
    say so one expiry made every future sync of that connection fail identically
    for ever. `syncConnection` drops the cursor and reports `reset: true`.
  
  Also: `DRIVE_ACCESS_DENIED`, `DRIVE_ITEM_NOT_FOUND` and `DRIVE_PROVIDER_ERROR`
  (the one `DRIVE_` code whose retryability the adapter decides), and a fix — the
  reactive refresh on a provider 401 that `Drives.run` documented but never
  performed, so a rejected-but-unexpired token failed the call outright.
  
  ### Upgrading `@basaltkit/drives` from 0.1.x
  
  Three shapes changed. Everything else compiles unchanged — the optional members
  above are additive, and an adapter that declares none of them keeps its 0.1
  behaviour.
  
  1. **`DriveNotificationOutcome.connection` → `connections` (a list).** Replace
     `if (outcome.connection) await sync(outcome.connection)` with
     `for (const c of outcome.connections) await sync(c)`. `connections` is always
     present and is `[]` when nothing matched, so a half-migrated call site reads
     a field that no longer exists instead of failing loudly — grep for
     `.connection` on an outcome.
  2. **A verified-but-unmatched notification returns instead of throwing.** A
     `try/catch` around `handleNotification` that mapped the old
     `DriveNotificationInvalidError` to a `400` no longer fires for it; check
     `outcome.reason === 'unmatched'`. A notification that cannot be *trusted* —
     bad signature, missing channel secret, a body that is not a notification —
     still throws the same error. Apps on `driveRoutes()` need no change.
  3. **`DriveRemoval.externalId` is optional.** A removal may now carry `path` and
     no `externalId` (and hence no `targetId`). An `onRemoved` that used
     `externalId` unconditionally needs a guard; on Google and Microsoft the value
     is still always there, only the type widened.
  
  The same migration is in the package README and in the drives guide (EN and PT).
  
  Both packages stay unpublished until the adapter is validated against a real
  Dropbox app.

### Patch Changes

- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [d552b84]
- Updated dependencies [aff3f6a]
  - @basaltkit/drives@0.2.0
