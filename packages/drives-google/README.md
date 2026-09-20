# @basaltkit/drives-google

Google Drive adapter for [`@basaltkit/drives`](../drives#readme).

Google is the provider the contract was most at risk of flattening: its change
feed starts at *now* rather than at the corpus, it throttles with a `403`, its
change feed has no folder scope at all, and a third of a typical Drive consists
of documents that have no bytes to download. Each of those is handled here
explicitly rather than approximated.

> **Status: `0.1.0`, unpublished.** Implemented and tested against a faithful
> fetch-level fake of Google's HTTP surface. It has not run against a real Google
> Cloud project — see [Not yet verified against live
> traffic](#not-yet-verified-against-live-traffic).

## Install

```bash
pnpm add @basaltkit/drives-google
```

`@basaltkit/drives` is a peer.

## Setup

```ts
import { drivesPlugin } from '@basaltkit/drives'
import { googleDrive } from '@basaltkit/drives-google'

const app = createApp({
  plugins: [
    filesPlugin({ disk: 'documents', validate: { sniff: true } }),
    drivesPlugin({
      providers: [
        googleDrive({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        }),
      ],
      keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
      secret: env.APP_SECRET,
    }),
  ],
})
```

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. **Enable the Google Drive API** for the project.
2. **OAuth client** of type *Web application*, with the redirect URI
   `https://app.example.com/drives/google/callback` — byte for byte what you
   pass as `redirectUri`.
3. **Scopes** — `drive.readonly` is the default. Uploading needs `drive.file`
   (files your app created) or `drive` (everything). `drive.readonly` and
   `drive` are *restricted* scopes: a public app needs Google's verification and
   an annual security assessment. An internal Workspace app does not.
4. **Push notifications** (optional) — the notification URL's domain must be
   **verified** in Google Search Console and registered in the project's domain
   verification list. Google does not do a challenge handshake; it simply
   refuses to create the channel.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `clientId` | — | OAuth client id. Required. |
| `clientSecret` | — | Client secret. Omit for a PKCE-only public client. **Not** a webhook key — Google does not sign notifications. |
| `scopes` | `drive.readonly` | Scopes requested at consent. |
| `pageSize` | `100` | `files.list` / `changes.list` page size. Clamped to 1…1000. |
| `listMode` | `'recursive'` | `'recursive'` walks a scoped folder's whole subtree; `'children'` lists one level. |
| `uploadMaxBytes` | `5 MB` | Hard ceiling for one upload. Cannot exceed Google's own simple-upload limit. |
| `watchTtlMs` | `7 days` | Channel TTL to request. Google's own `expiration` wins. |
| `includeUnscopedRemovals` | `false` | Forward hard deletions that cannot be scoped to `rootId` — see [Deletions](#deletions). |
| `ancestryMaxDepth` | `32` | Ancestry hops one scope check may walk. |
| `ancestryMaxLookups` | `500` | Metadata reads one `delta` call may spend on ancestry. |

## What maps to what

| Contract | Google |
| --- | --- |
| `authorization.authorizeUrl` | `accounts.google.com/o/oauth2/v2/auth` with `access_type=offline`, `prompt=consent`, PKCE S256 |
| `authorization.exchange` / `refresh` | `POST oauth2.googleapis.com/token` |
| `authorization.revoke` | `POST oauth2.googleapis.com/revoke` with the **refresh** token |
| `authorization.account` | `GET /drive/v3/about?fields=user(...)` → `permissionId`, email, display name |
| `list` + `DrivePage.cursor` | `files.list` with `'<id>' in parents and trashed = false`; a scoped listing walks the subtree |
| `get` | `files.get` |
| `download` | `files.get?alt=media` → **302 to `*.googleusercontent.com`** |
| `upload` | `POST /upload/drive/v3/files?uploadType=multipart`, streamed |
| `startDelta` + `delta` | `changes.getStartPageToken` then `changes.list` |
| `watch` / `unwatch` | `changes.watch` / `channels.stop` |
| `verifyNotification` | `X-Goog-Channel-Token` (the secret the engine generated) |
| `DriveItem.version` | `headRevisionId` |
| `DriveItem.checksum` | `{ algorithm: 'md5', value: md5Checksum }` |
| `DriveItem.externalUrl` | `webViewLink` |
| `DriveItem.exportOnly` | any `application/vnd.google-apps.*` document |
| `retryAfterFromBody` | **not declared** — Google uses `Retry-After`, and puts no hint in a body |

### Contract-validation matrix

The same rows phase 2a used, answered for Google. "Fits" means the capability
maps onto the contract with no caveat worth writing down.

| Capability | Fit | What the contract flattens, if anything |
| --- | --- | --- |
| OAuth | **fits** | `access_type=offline` + `prompt=consent` + PKCE all go in `authorizeUrl`, which is pure. |
| Refresh token | **fits** | Google does not rotate; the engine keeps the stored token when a response omits one, which is already the documented behaviour. |
| Revocation | **caveat** | `invalid_grant` means *revoked*, *client deleted*, **or** *unused for six months* (seven days while the app is in "testing"). Those are the same string on the wire and the contract has one status, `invalid`, for all of them. The action is the same — reconnect — but an operator cannot tell a revocation from an expiry, and no adapter can make that distinction for them. |
| List files | **caveat** | Drive has **no recursive query**. A scoped connection's listing therefore walks folder by folder, carrying its queue inside the opaque cursor. Correct, and it costs one request per folder rather than per page. |
| List folders | **fits** | Folders are ordinary files with `mimeType: …folder`; the engine skips them for import and they are what the walk follows. |
| Pagination | **fits** | `pageToken` is an opaque resumable cursor, exactly the contract's shape. |
| Download | **caveat** | Streams, but through a `302` to a signed `*.googleusercontent.com` URL. The contract handles it because the guarded fetch re-validates every hop; an adapter that followed redirects itself would be an SSRF sink. **Google-native documents cannot be downloaded at all** (see below). |
| File metadata | **caveat** | No `path` — Drive is a graph, a file can have several parents, and no path is published. `DriveItem.path` is simply absent, and the `path`-shaped removal Dropbox needs is unused. |
| Change detection | **caveat ×2** | (a) `getStartPageToken` is "from now on", so `deltaIncludesExisting: false` and the engine backfills. (b) `changes.list` is **account-wide**: a `rootId` connection filters client-side, which the contract has no vocabulary for — it is invisible to the engine and costs metadata reads. |
| Webhooks | **fits** | `changes.watch` is per-subscription with a secret we choose; `DriveWatch.expiresAt` carries Google's own expiration, and `raw` carries the `resourceId` that `channels.stop` needs. |
| Webhook verification | **fits, weakly** | The contract's `secret` correlation is exactly right — but Google signs **nothing**, so the channel token is the entire authentication. That is a Google property, not a contract gap. |
| Rate limits | **caveat** | A throttle is a `403` with a reason in the body, not a `429`. The guarded fetch's 429/503 interception never fires; the adapter raises `DriveRateLimitedError` itself. Mapping by status code would make every throttle terminal. |
| Retry | **fits** | `isRetryable` already retries `DRIVE_RATE_LIMITED` and a 5xx `DRIVE_PROVIDER_ERROR`, which is the whole of what Google needs. |
| Large files | **caveat** | Download is unbounded (the engine's byte cap applies); **upload stops at 5 MB**, because `uploadType=resumable` is a three-call protocol that is not implemented. Refused up front with `DRIVE_CONTENT_TOO_LARGE`. |
| Errors | **fits** | `DRIVE_ACCESS_DENIED` / `DRIVE_ITEM_NOT_FOUND` / `DRIVE_PROVIDER_ERROR` / `DRIVE_CURSOR_RESET` cover Google's taxonomy with nothing left over. |

Two places where the contract flattens a real difference and **should keep
doing so**: the single opaque cursor (Google's `pageToken` /
`newStartPageToken` pair collapses honestly into it), and `contentType` as an
untrusted hint (Drive's `mimeType` is authoritative for *native* documents and a
client-supplied guess for everything else — treating it as a hint is right for
both).

### The four things Google does differently

**The change feed starts at "now".** `changes.getStartPageToken` is documented as
the token for the *future*: the corpus that already exists never appears in
`changes.list`. So the adapter declares `deltaIncludesExisting: false` and the
engine takes the token, runs a full listing pass, and only then follows the feed.
Declaring it the other way is not a performance bug — a connection's first sync
reports success, imports nothing, and persists a cursor that guarantees the
existing files are never seen again. There is a test that makes the mistake on
purpose and asserts the silence.

**A throttle is a `403`.**

```json
{"error":{"code":403,"errors":[{"domain":"usageLimits",
  "reason":"userRateLimitExceeded","message":"User Rate Limit Exceeded"}]}}
```

The adapter reads `error.errors[].reason` and raises `DRIVE_RATE_LIMITED` for the
`usageLimits` family, keeping `DRIVE_ACCESS_DENIED` for a genuine permission
refusal (`insufficientPermissions`, `insufficientFilePermissions`,
`appNotAuthorizedToFile`, `domainPolicy`). The difference is not cosmetic:
`DRIVE_ACCESS_DENIED` is terminal, so mapping by status code alone permanently
fails a job over a condition that clears itself in a second.

**`changes.list` is account-wide.** There is one change feed per account (or per
shared drive); it cannot be scoped to a folder. A connection confined to a
`rootId` therefore filters **client-side**: each change's file resource is
scope-checked by walking `parents` upwards, with one metadata read per folder not
already seen, cached for the duration of a single `delta` call and never longer
(a longer-lived cache would be a cross-connection leak waiting for an id
collision). The cost is real — a busy Drive whose changes mostly fall outside the
connection's folder pays a metadata read per distinct folder, per page — and it
is bounded by `ancestryMaxLookups`, which fails loudly rather than guessing.
Out-of-scope changes are dropped **before** they become a `DriveChange`, so
nothing about another folder reaches `onRemoved`, the hooks or the ledger.

If a tenant's import is confined to one folder, prefer connecting that folder as
the `rootId` of its own connection and keeping the folder near the top of the
drive: the shallower it is, the cheaper every scope check.

**Google-native documents have no bytes.** A Doc, Sheet, Slide or Form has no
`md5Checksum`, no `size`, and `files.get?alt=media` answers `403
fileNotDownloadable`. They surface with `exportOnly: true` and `mimeType` in
`raw`, and `download` refuses them with `DRIVE_UNSUPPORTED` rather than calling
`files.export` and picking a format — PDF? DOCX? — that the app never asked for,
which would also produce an import whose "content version" is a checksum that
does not exist. `importItem` skips them under the `copy` strategy with
`reason: 'no-content'`, so they do not become permanently failing jobs. An app
that wants the export does it in its own sink:

```ts
const sink: DriveSink = async (input) => {
  if (input.item.exportOnly) {
    // input.item.raw.mimeType tells you what it is; choose your own format and
    // call files.export with your own credentials.
    return { targetId: await exportGoogleDoc(input.item) }
  }
  return filesSink(files)(input)
}

// Under `reference` nothing is downloaded, so the sink sees every item:
await importItem(drives, connectionId, item, sink, { strategy: 'reference' })
```

## Deletions

Google reports deletions **by id**, so the `path` shape Dropbox needs is unused
here. There are two kinds, and they are not equally useful:

| What happened | What arrives | Scoped connection |
| --- | --- | --- |
| Moved to trash (the ordinary delete) | the full file resource with `trashed: true` | scoped normally, reported with `externalId` |
| Deleted for ever, or the share was removed | `{fileId, removed: true}` and **no file resource** | dropped by default — there is nothing left to test the ancestry of |

Forwarding an unscopable removal would put an id from outside the connection's
folder into `onRemoved`, the hooks and any ledger lookup they drive. Set
`includeUnscopedRemovals: true` to receive them anyway and correlate against your
own ledger — which is the one place that genuinely knows which ids were imported.
An **unscoped** connection (no `rootId`) receives them either way.

## Renewing a subscription

Google caps a channel's life, and the cap is short enough that renewal is not
optional. `DriveWatch.expiresAt` carries Google's own `expiration` — never the
TTL you asked for, because believing your own number is how an app renews too
late and stops receiving notifications without an error anywhere.

Renewal is the **app's** job, because re-subscribing is provider traffic and the
framework does not decide when to spend it. `@basaltkit/scheduler` already has
the shape:

```ts
defineReconciler({
  name: 'drive-watch-renewal',
  every: '1h',
  find: () => connectionsWithWatchExpiringWithin('24h'),
  redispatch: (c) =>
    watchConnection(drives, c.id, {
      tenantId: c.tenantId,
      notificationUrl: `https://app.example.com/drives/google/notifications`,
    }),
}).schedule(scheduler)
```

`watchConnection` generates a **new** secret each time, so a renewed channel
cannot be addressed with the old one.

## Error mapping

| Google | Contract | Retried? |
| --- | --- | --- |
| `401` (`authError`, `invalidCredentials`) | `DRIVE_CREDENTIALS_INVALID` | one reactive refresh, then terminal |
| `403` `usageLimits` (`userRateLimitExceeded`, `rateLimitExceeded`, `sharingRateLimitExceeded`, `dailyLimitExceeded`, `quotaExceeded`) | `DRIVE_RATE_LIMITED` | **yes** |
| `403` (`insufficientPermissions`, `insufficientFilePermissions`, `appNotAuthorizedToFile`, `domainPolicy`, `cannotDownloadAbusiveFile`) | `DRIVE_ACCESS_DENIED` | no |
| `403` anything else (incl. `storageQuotaExceeded`, `fileNotDownloadable`) | `DRIVE_PROVIDER_ERROR` | no |
| `404` | `DRIVE_ITEM_NOT_FOUND` (or `null` from `get`) | no |
| `400 invalid` **on a call that carried a page token** | `DRIVE_CURSOR_RESET` — the engine drops the cursor and the next run re-primes | no |
| `400` anything else | `DRIVE_PROVIDER_ERROR` | no |
| `429` | `DRIVE_RATE_LIMITED` (normally intercepted by the guarded fetch first) | yes |
| `5xx` | `DRIVE_PROVIDER_ERROR` | yes |
| OAuth `invalid_grant` on refresh | `DRIVE_CREDENTIALS_INVALID` | no — the connection is marked `invalid` |
| OAuth `invalid_client` on refresh | a plain error | no — **not** treated as revocation, because it is your misconfiguration, not the tenant's |

Only Google's own `reason` vocabulary reaches an error's `details`. Its
free-text `message` never does — `details` is serialised into HTTP responses and
stored by `@basaltkit/audit`, and Google's messages quote file names.

## Security notes

- **The download redirect is the SSRF case this design exists for.**
  `.googleusercontent.com` is allowlisted as a leading-dot **suffix**, which
  matches `doc-04-7g-docs.googleusercontent.com` and refuses both
  `googleusercontent.com` itself and `evilgoogleusercontent.com`. The guarded
  fetch re-runs the allowlist, the SSRF validation and the IP pin on every hop,
  and the adapter never sees the signed URL — so it cannot log it. That URL is a
  bearer credential for the file.
- **`accounts.google.com` is not allowlisted.** The consent URL is handed to a
  browser and never fetched.
- **A folder id is validated, not escaped.** It goes into the `q` query language
  as a string literal, and one missed quote in an escape would widen a listing a
  tenant deliberately scoped. Anything that is not `[A-Za-z0-9_-]{1,512}` is
  refused outright.
- **`resourceUri` is never persisted.** It embeds a page token; only
  `resourceId` (which `channels.stop` needs) is stored.

## Limitations

- **Uploads over 5 MB** need `uploadType=resumable`, which is not implemented;
  larger files are refused up front with `DRIVE_CONTENT_TOO_LARGE`.
- **Shared drives are not addressed as a corpus.** `supportsAllDrives` and
  `includeItemsFromAllDrives` are sent on every request, so ids that live in a
  shared drive resolve and items shared into the user's Drive appear — but a
  connection scoped to a *shared drive* (`corpora=drive&driveId=…`, with its own
  change feed) is not wired.
- **`files.export` is not wired** (see above).
- **No `path`.** Correlate removals on `externalId`; `filesSink` records it as
  `metadata.driveExternalId`.
- **Service accounts and domain-wide delegation** are not implemented. A
  Workspace admin who wants to import on behalf of every user needs the JWT
  assertion flow, which is a different grant entirely; `drives.connect()` accepts
  tokens an app obtained by itself, which is the seam for it.

## Not yet verified against live traffic

Everything here is tested against a fake of Google's documented HTTP surface,
with no credentials. These are the points where a real project should be checked
before this package is published:

1. **The exact maximum channel TTL** for `changes.watch`, and whether Google
   silently clamps a larger `ttl` or refuses it. The adapter asks for at most
   seven days and then believes the `expiration` it gets back, which is safe
   either way.
2. **Whether an expired `pageToken` really answers `400` with
   `reason: invalid`.** Google publishes no distinct code for it. If it answers
   `404 notFound` instead, that is mapped too — but only on a call that carried
   a cursor.
3. **Whether the download redirect ever leaves `*.googleusercontent.com`.** If
   Google adds another CDN host, downloads fail **closed** with
   `DRIVE_HOST_NOT_ALLOWED` — visibly, not silently — and the allowlist needs a
   new suffix entry.
4. **Whether `refresh_token` is ever returned on a refresh.** The adapter keeps
   the stored one when the response omits it, which is safe either way.
5. **PKCE together with a client secret** for a Web-application client. Google
   documents both; the adapter always sends `code_challenge`/`code_verifier` and
   adds `client_secret` when configured.
6. **The `403` reason strings for Workspace policy refusals** (DLP, sharing
   restrictions). An unrecognised reason degrades to `DRIVE_PROVIDER_ERROR`
   rather than being mis-classified as a throttle.

## License

MIT
