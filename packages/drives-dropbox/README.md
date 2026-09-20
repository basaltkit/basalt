# @basaltkit/drives-dropbox

Dropbox adapter for [`@basaltkit/drives`](../drives#readme) — the first real
implementation of the provider contract, and the one that validates it.

Dropbox is deliberately first: it is the only one of the three targets that
**signs** its notifications, so it exercises the hostile half of the design
rather than the comfortable half.

> **Status: `0.1.0`, unpublished.** Implemented and tested against a faithful
> fetch-level fake of Dropbox's HTTP surface. It has not run against a real
> Dropbox app — see [Not yet verified against live
> traffic](#not-yet-verified-against-live-traffic).

## Install

```bash
pnpm add @basaltkit/drives-dropbox
```

`@basaltkit/drives` is a peer.

## Setup

```ts
import { drivesPlugin } from '@basaltkit/drives'
import { dropboxDrive } from '@basaltkit/drives-dropbox'

const app = createApp({
  plugins: [
    filesPlugin({ disk: 'documents', validate: { sniff: true } }),
    drivesPlugin({
      providers: [
        dropboxDrive({
          clientId: env.DROPBOX_APP_KEY,
          // Dropbox's app secret. It doubles as the webhook signing key —
          // Dropbox has no separate webhook secret and no per-connection one.
          clientSecret: env.DROPBOX_APP_SECRET,
        }),
      ],
      keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
      secret: env.APP_SECRET,
    }),
  ],
})
```

In the [Dropbox App Console](https://www.dropbox.com/developers/apps):

1. **Redirect URI** — `https://app.example.com/drives/dropbox/callback`, byte for
   byte what you pass as `redirectUri`.
2. **Permissions** — `account_info.read`, `files.metadata.read`,
   `files.content.read`, plus `files.content.write` if you upload.
3. **Webhook URI** — `https://app.example.com/drives/dropbox/notifications`.
   Dropbox verifies it with a `GET ?challenge=…` **when you press Save**, before
   any tenant has connected anything; `driveRoutes()` answers that.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `clientId` | — | App key. Required. |
| `clientSecret` | — | App secret. Omit for a PKCE-only public client; then webhooks need `webhookSecret`. |
| `webhookSecret` | `clientSecret` | Overrides the webhook signing key. |
| `scopes` | `account_info.read files.metadata.read files.content.read` | Scopes requested at consent. |
| `pageSize` | `500` | `list_folder` page size. Clamped to 1…2000. |
| `recursive` | `true` | Whether listings and the change feed walk subfolders. |
| `uploadMaxBytes` | `150 MB` | Hard ceiling for one upload. Cannot exceed Dropbox's own limit. |

## What maps to what

| Contract | Dropbox |
| --- | --- |
| `authorization.authorizeUrl` | `www.dropbox.com/oauth2/authorize` with `token_access_type=offline` + PKCE S256 |
| `authorization.exchange` / `refresh` | `POST /oauth2/token` |
| `authorization.revoke` | `POST /2/auth/token/revoke` |
| `authorization.account` | `POST /2/users/get_current_account` |
| `list` + `DrivePage.cursor` | `files/list_folder` + `files/list_folder/continue` |
| `get` | `files/get_metadata` |
| `download` | `POST content.dropboxapi.com/2/files/download`, argument in `Dropbox-API-Arg` |
| `upload` | `POST content.dropboxapi.com/2/files/upload` (single shot) |
| `startDelta` + `delta` | the same `list_folder` cursor — see below |
| `verifyNotification` | app-wide webhook, `X-Dropbox-Signature` (HMAC-SHA256 over the raw body) |
| `DriveItem.version` | `rev` |
| `DriveItem.checksum` | `{ algorithm: 'dropboxContentHash', value: content_hash }` |
| `retryAfterFromBody` | `error.retry_after` in a 429 body |

### Where Dropbox does not fit the shape phase 1 assumed

Five places, each of which changed the contract rather than being papered over.

**The change feed starts at the folder, not at "now".** `files/list_folder`
returns the first page of entries *and* the cursor; `/continue` carries on
through the rest of the folder and then into changes. There is no way to get a
cursor positioned at the beginning without receiving that first page, and
`get_latest_cursor` skips everything that already exists. So `startDelta`
returns a synthetic `basalt.dropbox.start:<path>` marker (the cursor is opaque to
the engine by contract) and the first `delta` call turns it into the
`list_folder` that produces both the entries and the real cursor. Because
backfill and delta are one continuum here, the adapter declares
`deltaIncludesExisting: true`. Google Drive is the opposite and must declare
`false`, at which point the engine runs a listing pass first.

**A deletion has no id.** A `deleted` entry is
`{".tag":"deleted", name, path_lower, path_display}` — the id belonged to the
thing that no longer exists. `DriveChange`'s removal variant therefore carries
`externalId` *or* `path`, and `onRemoved` reports whichever arrived. The import
ledger is keyed by id, so a path-based removal has no `targetId`: correlate on
the path you stored at import time (`filesSink` records it as
`metadata.drivePath`).

**There is no subscription and no secret of ours.** The webhook URI is
registered once per *app* and fires for every user who authorized it. `watch`
and `unwatch` are therefore absent — the engine reports `DRIVE_UNSUPPORTED`,
which is the honest answer — and a notification identifies a connection by the
Dropbox **account id** it names (`DriveNotificationResult.accountIds`). One
notification can fan out to several connections, so
`DriveNotificationOutcome.connections` is a list.

**The rate-limit hint is often in the body.** Dropbox frequently answers `429`
with no `Retry-After` and `{"error":{"retry_after":300}}` instead. The guarded
fetch destroys a rate-limited body before an adapter sees it, so the adapter
declares `retryAfterFromBody` and the engine applies it under its own ceiling.

**A cursor can die.** `list_folder/continue` answers `409 reset/` once a cursor
has aged out. The cursor is *persisted*, so mapped to any other error one expiry
would make every future sync of that connection fail identically for ever.
`DriveCursorResetError` tells the engine to drop it; the next run re-primes and
the ledger absorbs the repetition. Graph's `410 resyncRequired` and an aged-out
Google `pageToken` are the same thing under different names.

## Error mapping

| Dropbox | Contract | Retried? |
| --- | --- | --- |
| `401` (`expired_access_token`, `invalid_access_token`) | `DRIVE_CREDENTIALS_INVALID` | one reactive refresh, then terminal |
| `403` (`access_denied`, insufficient scope) | `DRIVE_ACCESS_DENIED` | no |
| `409 path/not_found` | `DRIVE_ITEM_NOT_FOUND` (or `null` from `get`) | no |
| `409 reset` | `DRIVE_CURSOR_RESET` — the engine drops the cursor and the next run re-primes | no |
| other `409` | `DRIVE_PROVIDER_ERROR` | no |
| `429` | `DRIVE_RATE_LIMITED` | yes, honouring `Retry-After` or the body hint |
| `4xx` | `DRIVE_PROVIDER_ERROR` | no |
| `5xx` | `DRIVE_PROVIDER_ERROR` | yes |
| OAuth `invalid_grant` on refresh | `DRIVE_CREDENTIALS_INVALID` | no — the connection is marked `invalid` |
| OAuth `invalid_client` on refresh | a plain error | no — **not** treated as revocation, because it is your misconfiguration, not the tenant's |

Only Dropbox's own `error_summary` vocabulary (`path/not_found/…`) is carried
into an error's `details`. Anything else — an HTML page from a proxy, a body an
attacker influenced — becomes `http_<status>`, because `details` is serialised
into HTTP responses and stored by `@basaltkit/audit`.

## Content hash

`content_hash` is **not** the SHA-256 of the file: it is SHA-256 over the
concatenated SHA-256 digests of 4 MiB blocks. The adapter labels it
`dropboxContentHash` so nothing compares it with another provider's digest of
the same bytes and concludes the files differ.

```ts
import { DropboxContentHash, dropboxContentHash } from '@basaltkit/drives-dropbox'

dropboxContentHash(bytes)                    // one shot
const h = new DropboxContentHash()           // or streamed
for await (const chunk of stream) h.update(chunk)
h.digest()
```

## Limitations

- **Uploads over 150 MB** need `files/upload_session/{start,append_v2,finish}`,
  which is not implemented. Anything larger is refused up front with
  `DRIVE_CONTENT_TOO_LARGE` rather than after the bytes have been sent.
- **Dropbox Business team spaces** are not addressed: `Dropbox-API-Path-Root`
  and `Dropbox-API-Select-User` are not sent, so a connection acts in the
  member's own space.
- **Export-only items** (Paper docs, some Google-backed files) surface with
  `exportOnly: true`; `files/export` is not wired, and `download` refuses them
  with `DRIVE_UNSUPPORTED`.
- **No `externalUrl`.** Dropbox metadata carries no web link, and manufacturing
  one would mean creating a share.
- **No longpoll.** `files/list_folder/longpoll` on `notify.dropboxapi.com` is
  allowlisted but unused; scheduled sync plus the webhook covers the same ground
  without holding a connection open.

## Not yet verified against live traffic

Everything here is tested against a fake of Dropbox's documented HTTP surface,
with no credentials. These are the points where a real app should be checked
before this package is published:

1. **PKCE together with an app secret.** The adapter always sends
   `code_challenge`/`code_verifier` and adds `client_secret` when configured.
   Dropbox documents both, but not explicitly in combination.
2. **Whether `refresh_token` is ever returned on a refresh.** The adapter keeps
   the stored one when the response omits it, which is safe either way.
3. **The exact `error_summary` strings** for scope and team-policy refusals; the
   mapping keys off `403` and the `path/not_found` prefix, so a different string
   degrades to `DRIVE_PROVIDER_ERROR` rather than being mis-handled.
4. **Whether `429` ever arrives with both `Retry-After` and a body hint**, and
   which Dropbox intends to win. The adapter prefers the header.
5. **`content_hash` against a real file.** No official test vector is published;
   the implementation follows the documented block-tree construction and the
   tests assert that construction, not a captured value.

## License

MIT
