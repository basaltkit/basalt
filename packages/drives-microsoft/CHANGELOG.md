# @basaltkit/drives-microsoft

## 1.0.0

### Major Changes

- e53db52: Framework audit, pass 2, section E (FA-072..FA-076): drives hardening.
  
  **`@basaltkit/drives` (0.x — minor is the breaking slot)**
  
  - **Signed listing cursors (FA-072/FA-073).** `listItems()` now returns `bkl1.<adapter cursor>.<mac>`, MAC-bound (key derived from `secret`) to the tenant and connection, and refuses any other cursor with `DRIVE_ACCESS_DENIED` before the adapter sees it. A Graph cursor is a URL fetched with the connection's bearer token, so a caller-authored one could read another drive. *Migration:* pass cursors back unchanged; a cursor issued before the upgrade or under a rotated `secret` must be dropped (list again from the start). Stored sync cursors are unaffected.
  - **Refresh race (FA-074).** A worker told `invalid_grant` now invalidates only by compare-and-set, and only if the row still holds the rejected refresh token (otherwise it adopts the newer credentials); a winner that finds itself invalidated by such a loser restores the connection with its fresh tokens. No API change.
  - **Per-provider replay keys (FA-075).** The replay guard no longer reads `x-goog-message-number` from every provider; it keys on the new optional `DriveNotificationResult.replayKey` or a digest of the raw body. *Migration (custom adapters):* report `replayKey` if your vendor's body does not distinguish deliveries.
  - **FA-076.** `DriveSecretBox` pins a 16-byte GCM tag (truncated tags refused) and rejects NUL in the AAD context; watch secrets are stored as a `sha256:` digest (legacy plain rows still match); `timeoutMs` is documented as an inactivity timeout and now also bounds each wait for response headers, with a new opt-in whole-exchange `deadlineMs` (`DrivesOptions`, `DriveFetchOptions`, `GuardedRequestInit`); the OAuth callback echoes only a well-formed `?error=` code; the anonymous notification route answers an unknown provider with `DRIVE_NOTIFICATION_INVALID` instead of listing registered providers.
  
  **Adapters (major: `rootId` confinement now refuses calls that used to succeed)**
  
  - **Root confinement (FA-073).** With a `rootId`, a `folderId`, `getItem`, `download` and an upload target outside the root are refused with `DRIVE_ACCESS_DENIED` (`get` returns `null`). Google walks `parents` (resolving the `root` alias); Microsoft walks `parentReference.id` for an `item:` root (new `ancestryMaxDepth` option); Dropbox compares `path_lower` (lexically for paths, one `get_metadata` for `id:`/`ns:`, the download's `Dropbox-API-Result` before its body is read). *Migration:* a connection that relied on reaching outside its root must be reconnected with a wider root (or none).
  - `@basaltkit/drives-google` reports `X-Goog-Message-Number` as `replayKey`. Requires `@basaltkit/drives` ≥ 0.3.

### Patch Changes

- Updated dependencies [e54b7b1]
- Updated dependencies [e53db52]
- Updated dependencies [e54b7b1]
  - @basaltkit/drives@0.3.0

## 0.1.0

### Initial release

- aff3f6a: Drives phase 2c: the OneDrive / SharePoint adapter, and the three contract
  changes Microsoft forced.
  
  **New — `@basaltkit/drives-microsoft` 0.1.0 (unpublished).** The Microsoft Graph
  adapter: Entra ID OAuth with PKCE, `offline_access` and **rotating** refresh
  tokens, against the `common`/`organizations`/`consumers` endpoints or one
  specific tenant; `/children` listings paging on `@odata.nextLink`; `/delta` as
  both backfill and change feed (`deltaIncludesExisting: true`), finishing on
  `@odata.deltaLink` and answering `410 resyncRequired` with
  `DRIVE_CURSOR_RESET`; streaming downloads through the pre-signed
  `@microsoft.graph.downloadUrl`, fetched **unauthenticated** and never allowed
  into an item, a listing, a log or an error; simple uploads streamed onto the
  socket up to Graph's 4 MB ceiling and refused up front above it; `quickXorHash`
  / `sha256` / `sha1` checksums labelled by what the account type actually
  publishes; Graph subscriptions authenticated by the engine's `clientState`, with
  `expiresAt` surfaced for app-side renewal; and an explicit `rootId` grammar
  (`microsoftRoot()`) so a connection says out loud whether it means a personal
  OneDrive, a specific drive or a SharePoint site's document library.
  
  Graph has **no per-application revocation endpoint**, so `revoke` is omitted and
  `disconnect` reports `revoked: false` — documented plainly, because "disconnect"
  then means less on OneDrive than elsewhere: the grant may still be live until the
  user removes consent in their account portal.
  
  **`@basaltkit/drives` — three changes, all of them places the contract was right
  for the first two vendors and wrong for the third:**
  
  - **`DriveNotificationResult.secrets`.** One Graph delivery can batch entries for
    several subscriptions that share a notification URL — two connections behind
    one route is the ordinary case. With a single `secret` the engine synced one
    connection and left the rest stale, which is the failure `accountIds` and
    `DriveNotificationOutcome.connections` were added for in phase 2a, arriving
    from the other direction. An adapter sets `secret` for an ordinary delivery
    and `secrets` for a batch; the matcher accepts either.
  - **`DriveRefreshInput.scopes`.** Microsoft wants a refresh request's `scope` to
    be a subset of the original grant's, and the input carried only the refresh
    token — so an adapter could only send its own defaults, quietly narrowing a
    connection that had consented to `Sites.Read.All` down to `Files.Read`. It
    keeps working until the first SharePoint call, which then fails as a
    permissions problem a long way from the cause. The connection already stores
    its granted scopes; the engine now passes them. Dropbox and Google ignore it.
  - **The guarded fetch no longer forwards credentials across a cross-host
    redirect** (bug fix). `createDriveFetch` re-validated every hop but reused the
    request headers unchanged, so an `Authorization` header followed a `302` to
    another host. Graph's `/content` redirects to a SharePoint or `1drv.com` CDN
    and Google Drive's download redirects to `googleusercontent.com`: in both
    cases a provider-wide bearer token was being presented to a host that already
    holds a narrow pre-signed URL and needs nothing. `authorization`, `cookie` and
    `proxy-authorization` are now dropped when the redirect changes host. The
    allowlist bounds which hosts a redirect may reach; it never made them entitled
    to the token.
  
  `@basaltkit/drives-microsoft` stays unpublished until the adapter is validated
  against a real Entra ID app registration.

### Patch Changes

- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [d552b84]
- Updated dependencies [aff3f6a]
  - @basaltkit/drives@0.2.0
