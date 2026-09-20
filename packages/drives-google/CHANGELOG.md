# @basaltkit/drives-google

## 0.1.0

### Initial release

- aff3f6a: Drives phase 2b: `@basaltkit/drives-google`, the Google Drive adapter.
  
  **New — `@basaltkit/drives-google` 0.1.0 (unpublished).** OAuth with
  `access_type=offline`, `prompt=consent` and PKCE, plus refresh and grant
  revocation; `files.list` pagination that **walks a scoped folder's subtree**
  (Drive has no recursive query, and a top-level-only backfill would silently miss
  most of a tenant's documents); `files.get`; streaming `files.get?alt=media`
  through the `302` to `*.googleusercontent.com`; a streamed multipart upload under
  Google's 5 MB simple-upload ceiling; `changes.getStartPageToken` +
  `changes.list` for incremental sync; `changes.watch` / `channels.stop` with the
  engine's per-subscription secret; and `md5Checksum` surfaced honestly as
  `{ algorithm: 'md5' }`.
  
  Four Google behaviours the contract had to be checked against, all of which it
  already expressed:
  
  - **`deltaIncludesExisting: false`.** `changes.getStartPageToken` means "from now
    on", so the engine backfills with a listing pass first. Declaring it the other
    way makes a connection's first sync report success and import **nothing** — a
    test makes that mistake on purpose and asserts the silence.
  - **A throttle is a `403`, not a `429`**, with the reason in
    `error.errors[].reason`. The adapter raises `DRIVE_RATE_LIMITED` for the
    `usageLimits` family and keeps `DRIVE_ACCESS_DENIED` for a genuine permission
    refusal — mapping by status code alone would make every throttle terminal.
  - **`changes.list` is account-wide.** A connection confined to a `rootId` filters
    client-side by walking ancestry, with a per-call cache and a hard lookup
    budget; out-of-scope changes are dropped before they become a `DriveChange`, so
    another folder's metadata never reaches `onRemoved`, the hooks or the ledger.
    A hard deletion (`{fileId, removed: true}`, no file resource) cannot be scoped
    at all and is dropped by default, with `includeUnscopedRemovals` as the opt-in.
  - **Google-native documents have no bytes.** Docs/Sheets/Slides surface with
    `exportOnly: true`; `download` refuses them rather than exporting to a format
    the app never asked for.
  
  **`@basaltkit/drives` — one behaviour fix, no contract change.** `importItem`
  now skips an `exportOnly` item under the `copy` strategy with
  `reason: 'no-content'`, the skip reason phase 1 declared and nothing ever
  emitted. Without it every Google Doc in a tenant's drive becomes a permanently
  failing import job, re-enqueued by every sync because a failure never reaches the
  ledger. `reference` is unaffected: nothing is downloaded there, so a sink that
  wants to run its own export still sees the item.
  
  The adapter stays unpublished until it has been validated against a real Google
  Cloud project.

### Patch Changes

- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [aff3f6a]
- Updated dependencies [d552b84]
- Updated dependencies [aff3f6a]
  - @basaltkit/drives@0.2.0
