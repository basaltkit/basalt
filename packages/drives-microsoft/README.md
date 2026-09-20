# @basaltkit/drives-microsoft

The **OneDrive / SharePoint** adapter for [`@basaltkit/drives`](../drives), over
Microsoft Graph.

It is translation and nothing else. It holds no credential store, never sees a
refresh token — the engine hands it one short-lived access token per call — and
never calls `fetch`: only `session.fetch`, which is host-allowlisted,
SSRF-validated, IP-pinned, byte-capped and timed out. Retry, backoff, dedup,
tenancy and encryption at rest all live above it.

> **Unpublished (0.1.0).** Tested against a faithful fetch-level fake of Graph's
> documented HTTP surface, with no credentials and no network. See
> [Not verified against live traffic](#not-verified-against-live-traffic).

## Install

```bash
pnpm add @basaltkit/drives-microsoft
```

## Setup

```ts
import { drivesPlugin } from '@basaltkit/drives'
import { microsoftDrive } from '@basaltkit/drives-microsoft'

drivesPlugin({
  providers: [
    microsoftDrive({
      clientId: env.MS_CLIENT_ID,
      // A web app registration has a secret; a public client uses PKCE alone.
      // Unlike Dropbox it is NOT also a webhook key — Graph does not sign
      // notifications at all.
      clientSecret: env.MS_CLIENT_SECRET,
      tenant: 'common',
    }),
  ],
  keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
  secret: env.APP_SECRET,
})
```

In the [Entra ID app registration](https://entra.microsoft.com):

1. **Redirect URI** — `https://app.example.com/drives/microsoft/callback`, a
   *Web* platform redirect, byte for byte what `driveRoutes({ redirectUri })`
   produces.
2. **API permissions** — delegated Microsoft Graph permissions; see
   [Scopes](#scopes).
3. **Nothing to register for webhooks.** Graph subscriptions are created at
   runtime by `watchConnection()`, and Graph validates the notification URL
   *while creating each one* — see [Notifications](#notifications).

### Which authority: `tenant`

| `tenant` | Who can connect |
|---|---|
| `common` (default) | any Microsoft account — personal **and** work/school |
| `organizations` | work/school accounts only |
| `consumers` | personal Microsoft accounts only |
| a tenant GUID or verified domain | that one Entra tenant |

**If the app registration is single-tenant**, set `tenant` to that tenant's GUID
or domain: the `common` endpoint will issue a token that the registration then
refuses, and the failure shows up as `AADSTS50194` at the *callback*, after the
user has consented.

**If it is multi-tenant**, keep `common` (or `organizations`) and expect three
things that do not happen single-tenant:

- **Admin consent per customer tenant.** A tenant administrator must approve the
  application before any user in it can consent. Until then every connect ends in
  `DRIVE_AUTHORIZATION_INVALID` with `consent_required` or
  `AADSTS65001`, which is a customer-side action, not a bug.
- **Conditional-access policies you do not control.** A refresh can come back
  `interaction_required`; this adapter maps it to `DRIVE_CREDENTIALS_INVALID`,
  the connection is marked `invalid`, and the user has to reconnect. That is
  the honest answer — no token flow can satisfy a policy that demands a human.
- **One app registration, many tenants' data.** The connection row already
  scopes everything by `tenantId`; nothing extra is needed, but the client
  secret is now a credential that reaches every customer tenant, so it belongs in
  a secret manager and on a rotation schedule.

### Scopes

Default: `offline_access User.Read Files.Read` — the least that works for a
read-only personal OneDrive connection. `offline_access` is what makes Entra ID
return a refresh token at all; the adapter adds it if you forget, because
otherwise the failure only appears *after* the user has consented.

| You want | Add |
|---|---|
| the signed-in user's own OneDrive, read | `Files.Read` |
| …and write back | `Files.ReadWrite` |
| any drive the user can reach, read | `Files.Read.All` |
| …and write back | `Files.ReadWrite.All` |
| a **SharePoint** site's document library | `Files.Read.All` **and** `Sites.Read.All` |
| …and write back | `Files.ReadWrite.All` **and** `Sites.ReadWrite.All` |

`Sites.Read.All` is what lets `/sites/{siteId}/drive` resolve at all; without it
a site-scoped connection answers `403 accessDenied` on every call while the
token is perfectly valid — which is why that is `DRIVE_ACCESS_DENIED` and not
`DRIVE_CREDENTIALS_INVALID` (telling the tenant to re-consent would not fix it).

The scopes are requested at `startAuthorization({ scopes })`, stored on the
connection from Entra ID's own `scope` response, and sent back on every refresh.
**The code exchange deliberately sends no `scope`**: the authorization code
already names what the user consented to, and asserting a list here could only
disagree with it.

### Choosing a drive

Graph has three things a connection could reasonably mean, and a bare id cannot
tell them apart — a drive id and a site id are both opaque strings, and guessing
wrong produces a `404 itemNotFound` that reads like a permissions problem. So the
target is **explicit**, in the connection's `rootId`:

| `rootId` | Graph resource |
|---|---|
| absent, or `me` | `/me/drive/root` — the signed-in user's OneDrive |
| `drive:{driveId}` | `/drives/{driveId}/root` |
| `site:{siteId}` | `/sites/{siteId}/drive/root` — the site's **default** document library |
| `item:{itemId}` | `/me/drive/items/{itemId}` |
| `drive:{driveId}/item:{itemId}` | a folder in that drive |
| `site:{siteId}/item:{itemId}` | a folder in that library |
| a bare Graph item id | `items/{id}` in the connection's own drive |

Build one with `microsoftRoot()` rather than by hand:

```ts
import { microsoftRoot } from '@basaltkit/drives-microsoft'

await drives.connect({
  provider: 'microsoft',
  label: 'Contracts library',
  tokens,
  rootId: microsoftRoot({ siteId: 'contoso.sharepoint.com,8b1e…,7f2c…' }),
})
```

`rootId` is **caller-controlled** — `driveRoutes()` takes it from `?rootId=` on
the connect URL — and it becomes part of a Graph request path. Every segment is
validated: `/`, `?`, `#`, `%`, `:`, whitespace, `.` and `..` are all refused with
`DRIVE_ACCESS_DENIED`, and the refusal never echoes the handle back. A
`folderId` may narrow a call to a folder but **never** name another drive.

## Options

| Option | Default | Notes |
|---|---|---|
| `clientId` | — | required |
| `clientSecret` | — | omit for a public (PKCE-only) client |
| `tenant` | `common` | see [above](#which-authority-tenant) |
| `scopes` | `offline_access User.Read Files.Read` | `offline_access` is added if missing |
| `refreshScopes` | the connection's stored scopes | override only if you know why |
| `prompt` | — | `select_account`, `consent`, `login` |
| `downloadHosts` | `.files.1drv.com`, `.sharepoint.com`, `.svc.ms` | see [SSRF](#ssrf-the-download-url-is-a-credential) |
| `pageSize` | `200` | `$top`, clamped to 1…999 |
| `uploadMaxBytes` | `4 MB` | also the maximum |
| `subscriptionTtlMs` | ~29.4 days | clamped to Graph's ceiling |
| `changeTypes` | `['updated']` | covers create, edit and delete |

## What maps to what

| Contract | Microsoft Graph |
|---|---|
| `authorizeUrl` | `login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`, PKCE S256, `response_mode=query` |
| `exchange` / `refresh` | `POST {authority}/oauth2/v2.0/token` |
| `revoke` | **absent** — see [Revocation](#revocation-does-not-exist) |
| `account` | `GET /v1.0/me` |
| `list` | `GET {resource}/children?$top&$select`, paging on `@odata.nextLink` |
| `get` | `GET {resource}?$select` |
| `download` | `@microsoft.graph.downloadUrl`, fetched **unauthenticated** |
| `upload` | `PUT {resource}:/{name}:/content` (≤ 4 MB) |
| `startDelta` / `delta` | `GET {resource}/delta`, finishing on `@odata.deltaLink` |
| `watch` / `unwatch` | `POST` / `DELETE /v1.0/subscriptions` |
| `verifyNotification` | `validationToken` echo, then `clientState` |
| `DriveItem.version` | `cTag` (not `eTag`: that moves on a rename too) |
| `DriveItem.checksum` | `quickXorHash`, else `sha256`, else `sha1` |
| `DriveItem.exportOnly` | a `package` facet (OneNote) |
| `DriveChange` removal | the item's **id** plus a `deleted` facet |

### Where Microsoft lands on the other side of Dropbox

Every one of these changed the contract in phase 2a, and Graph is the case each
change was predicted for.

**The change feed enumerates first.** `/delta` with no token walks the drive and
only then hands over a `deltaLink`, so backfill and delta are one continuum. The
adapter declares `deltaIncludesExisting: true` and the engine skips the separate
listing pass. (Google's `changes.getStartPageToken` is the opposite and must
declare `false`, or its first sync imports nothing.)

**Refresh tokens rotate, every time.** The old one is dead the instant a new one
is issued. Nothing here works around that: the adapter reports what Entra ID
said and the engine's compare-and-set persists it. The consequence is subtler
than it looks — a second worker that refreshed a moment ago has already retired
the token this one is spending, and Entra ID answers that with the *same*
`invalid_grant` it uses for a revoked consent. The adapter reports it as
terminal, which is correct; the engine re-reads the row before condemning the
connection and adopts the winner's credentials. Deciding in the adapter would
mean deciding without the store.

**Deletions carry an id.** `{ id, deleted: { state: 'deleted' } }`, so
`DriveRemoval.targetId` resolves and the path-only removal shape Dropbox needs is
never used here.

**Pagination is a URL, not a token.** `@odata.nextLink` and `@odata.deltaLink`
are complete URLs you GET verbatim. They are wrapped in an opaque cursor
(`basalt.msgraph.list:…`, `basalt.msgraph.delta:…`) so Graph's paging state never
lands in an app's database or logs as something fetchable, and unwrapped only
after checking that the URL still points at Graph — before the guarded fetch
re-validates it for real.

**Notifications use a secret we chose.** `clientState` is set from the engine's
per-subscription random secret and compared in constant time on the way back.
`accountIds` is not needed. One delivery can batch entries for several
subscriptions that share a notification URL, so the adapter reports
`DriveNotificationResult.secrets` and every matching connection is synced.

## Notifications

```ts
await watchConnection(drives, connectionId, {
  notificationUrl: 'https://app.example.com/drives/microsoft/notifications',
})
```

Two things are worth knowing before the first one fails.

**Graph validates the URL synchronously.** While `POST /subscriptions` is in
flight, Graph calls your notification endpoint with `?validationToken=…` and
expects it echoed as `text/plain` within seconds. `driveRoutes()` already answers
that from `DriveNotificationResult.challenge` — the same neutral route that
answers Dropbox's `GET ?challenge=`. A `watch()` failing with
`subscriptionValidationFailed` means the route is not reachable from the
internet, not that the code is wrong.

**Subscriptions expire and Graph never renews them.** Under 30 days for a drive;
`DriveWatch.expiresAt` is surfaced, and renewal is the app's job:

```ts
import { defineReconciler } from '@basaltkit/scheduler'

defineReconciler({
  name: 'drive-watch-renewal',
  every: '6h',
  find: async () =>
    (await drives.list({ tenantId })).filter(
      (c) => c.provider === 'microsoft' && c.watching,
    ),
  // Re-subscribing is the renewal: a fresh subscription, a fresh secret, a
  // fresh expiry. Do it well before `expiresAt`, because a lapsed subscription
  // is silent — notifications simply stop.
  redispatch: (c) =>
    watchConnection(drives, c.id, {
      tenantId: c.tenantId,
      notificationUrl: 'https://app.example.com/drives/microsoft/notifications',
    }),
}).schedule(scheduler)
```

A notification is never trusted for content: Graph's `driveItem` notifications
name the drive root, never the item that changed, so the only thing a delivery
can cause is "go and ask Graph, with our own credentials, for our own tenant".
Keep the scheduled sync as well — a webhook is an optimisation, not a guarantee.

## Revocation does not exist

Graph has **no per-application revocation endpoint**. `POST
/me/revokeSignInSessions` invalidates the user's tokens for *every* application,
which is not what "disconnect this drive" means and is not ours to do. Consent is
withdrawn by the user at `myaccount.microsoft.com` → *Apps you can access*, or by
an administrator in Entra ID.

`revoke?` is optional in the contract, so this adapter **omits it**. The
consequence, stated plainly because an operator needs to know it:

> `drives.disconnect()` deletes the connection row and its sealed credentials and
> emits `drive:disconnected` with **`revoked: false`** and
> **`revocation: 'unsupported'`**. The app can no longer use the grant — it no
> longer has the tokens — but **the grant itself may still be live at Microsoft**
> until the user or an administrator removes it. "Disconnect" therefore means
> less on OneDrive than it does on Dropbox or Google.

Branch on `revocation`, never on `revoked` alone. The boolean is also `false` on
Dropbox and Google when the revoke call simply did not get through, and that
case is worth **retrying** — the opposite instruction to this one.
`'unsupported'` is the value that means "there is nothing to retry, ever".

If your compliance story needs the grant gone, tell the user where to remove it
and record that you did.

## SSRF: the download URL is a credential

`@microsoft.graph.downloadUrl` is a short-lived pre-signed URL on a *different
host*, and `/content` answers `302` to the same place. RFC 0002 §5.1 calls this
the primary risk, and the adapter treats it as one:

- **The allowlist entries are `.suffix`, never bare parents.**
  `.sharepoint.com` matches `contoso-my.sharepoint.com` and refuses
  `sharepoint.com` and `evilsharepoint.com` alike. Narrow it to your own tenant
  host with `downloadHosts: ['contoso-my.sharepoint.com']` if you know it —
  strictly better, one line.
- **The guarded fetch re-validates every hop** (allowlist, SSRF, IP pinning),
  and drops the `Authorization` header when a redirect changes host.
- **The URL is never sent an `Authorization` header**, because it does not need
  one; presenting a Graph bearer token to a CDN would hand a far wider credential
  to a host that already holds a narrow one.
- **The URL never leaves this adapter.** Listings `$select` it away, so it is
  not in `DriveItem.raw`, not in a sink, not in a log. `download` asks for it,
  uses it immediately, and throws it away.
- **It is never in an error.** A failure from the content host is reported as
  `DRIVE_PROVIDER_ERROR` with the fixed summary `downloadRejected` and the body
  destroyed unread — CDN error pages quote the request URL.

## Error mapping

| Graph | Contract |
|---|---|
| `401` | `DRIVE_CREDENTIALS_INVALID` (the engine refreshes once, then condemns) |
| `403` | `DRIVE_ACCESS_DENIED` — a missing scope, a sensitivity label, a conditional-access policy. The token is fine; re-consenting does not help |
| `404` | `DRIVE_ITEM_NOT_FOUND` (and `get()` answers `null`) |
| `410 resyncRequired` | `DRIVE_CURSOR_RESET` — the sync drops the cursor and re-primes |
| `423` | `DRIVE_PROVIDER_ERROR`, **retryable** — checked out, virus-scanned, co-authored |
| `429` / `503` | `DRIVE_RATE_LIMITED`, from the guard, honouring `Retry-After` |
| `507` | `DRIVE_PROVIDER_ERROR` — the drive is full |
| `5xx` | `DRIVE_PROVIDER_ERROR`, retryable |

Only `error.code` is forwarded — a fixed camelCase vocabulary. `error.message`
never is: Graph's messages quote the request, and on a download path that
request is a credential. `innerError.request-id` is useful in a support ticket
but has nowhere to go in the contract's error shape, so it is not smuggled into
the summary either.

There is no `retryAfterFromBody`: Graph always sends `Retry-After` with a
throttle and puts no number in the body, so declaring a parser that could only
return `undefined` would make the guard read a body it is right to destroy.

## Checksums

`file.hashes` differs by **account type**, and the adapter labels what it
actually got:

| Drive | Hash | `DriveChecksum.algorithm` | Encoding |
|---|---|---|---|
| OneDrive for Business, SharePoint | `quickXorHash` | `quickXorHash` | base64, as Graph publishes it |
| OneDrive personal | `sha256Hash` | `sha256` | lowercased hex |
| OneDrive personal (older items) | `sha1Hash` | `sha1` | lowercased hex |

`quickXorHash` is preferred when present, because it is the only hash a Business
drive publishes at all.

> A checksum is comparable **within one provider**, and on Graph only **within
> one account type**. A `quickXorHash` is a Microsoft block-XOR construction with
> no counterpart anywhere; comparing it with a Dropbox `content_hash` or a
> Google `md5Checksum` — or with a `sha256` from a personal OneDrive — compares
> two different functions and concludes every file differs.

## Limitations

- **Uploads over 4 MB.** Graph's simple `PUT …/content` ceiling — the lowest of
  the three vendors. Larger files need `createUploadSession`, a resumable
  three-call protocol with its own chunking and retry story, deliberately out of
  scope for now. Anything larger is refused **up front** with
  `DRIVE_CONTENT_TOO_LARGE`, before the bytes are sent.
- **A subscription covers the whole drive.** Graph only accepts `/drives/{id}/root`
  as a `driveItem` subscription resource, so a connection scoped to a subfolder
  still receives notifications for the entire drive. It costs a wasted sync,
  never a wrong one: the sync itself stays confined to the connection's root.
- **Items with no downloadable bytes are reported, not fetched.** A OneNote
  notebook (`package` facet) and a "Shared with me" shortcut (`remoteItem`
  facet, whose bytes live in another drive) both surface with
  `exportOnly: true`, and `download` refuses. That flag is what makes
  `importItem` skip them as `no-content`: without it every one of them is an
  import job that fails, re-enqueues and fails again on every sync, for ever.
- **Cross-drive shared items** are otherwise out of scope. An item that lives in
  someone else's drive is addressed by its owning drive; a connection is
  deliberately confined to one, so connect the owning drive instead.
- **SharePoint lists and non-default libraries.** `site:{siteId}` resolves the
  site's *default* document library. A second library is reachable by its own
  `drive:{driveId}`.
- **Delta on a subfolder** uses `/items/{id}/delta`, which Graph supports for
  OneDrive; a SharePoint library with a very large item count may be happier
  scoped at the drive root.

## Not verified against live traffic

Tested against a faithful fetch-level fake of Graph's documented HTTP surface,
with no credentials and no network. These need a real Entra ID app registration
to confirm:

- **Whether every refresh really rotates** for every account type. The adapter
  and the engine handle both, so a non-rotating response is absorbed; the fake
  always rotates, which is the harder direction.
- **The exact `error.code` strings** for a missing `Sites.Read.All`, a
  sensitivity label and a conditional-access refusal — all mapped as `403 →
  DRIVE_ACCESS_DENIED`, which does not depend on the string, but the strings
  end up in `details` and in operators' dashboards.
- **Whether a `429` ever arrives without `Retry-After`.** If it does, this
  adapter should declare `retryAfterFromBody` after all.
- **The `$select` behaviour of `@microsoft.graph.downloadUrl`** — documented as
  selectable, and the whole "the credential never reaches a listing" property
  rests on it. If a tenant returns it regardless, the property becomes "the
  adapter drops it" rather than "Graph never sends it"; `toDriveItem` already
  does not copy it either way.
- **`/delta` on a SharePoint document library at scale**, including whether a
  `deltaLink` survives longer than the sync interval.
- **The exact `expirationDateTime` ceiling** per resource type; the adapter
  clamps to the documented 42 300 minutes and re-reads whatever Graph returns.
- **Whether a batched notification delivery really mixes `clientState` values**
  in the wild. The handling is there because the shape allows it.

## License

MIT
