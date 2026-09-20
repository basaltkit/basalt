# External drives

`@basaltkit/drives` connects a tenant's **external file-storage accounts** —
Google Drive, OneDrive/SharePoint, Dropbox — to your app, so documents that live
somewhere else can be listed, imported and kept in sync.

The provider-specific part is small and lives in an adapter. Everything above it
is generic and lives here: many connections per tenant, OAuth credentials
encrypted at rest with refresh and rotation, provider-agnostic pagination,
streaming download that never buffers, incremental sync on a cursor, dedup,
rate-limit backoff, and inbound notification verification.

[[toc]]

## Upgrading from 0.1.x

::: warning Three shapes changed
Everything else in 0.1.x still compiles. The optional members the adapters added
(`deltaIncludesExisting`, `retryAfterFromBody`, `accountIds`, `secrets`,
`DriveRefreshInput.scopes`) are additive, and an adapter that declares none of
them keeps its 0.1 behaviour.
:::

**1. A notification resolves to a list of connections.** One Dropbox delivery
names *accounts*, and one account can be connected several times (two labels in
one tenant, or the same account connected by two tenants). 0.1 returned a single
connection, which would have synced one of them and left the rest stale.

```ts
// 0.1.x
if (outcome.shouldSync && outcome.connection) await sync(outcome.connection)

// 0.2.0
if (outcome.shouldSync) for (const connection of outcome.connections) await sync(connection)
```

`connections` is always present and is `[]` when nothing matched. Grep your app
for `.connection` on an outcome: a half-migrated call site reads a field that no
longer exists rather than failing loudly.

**2. A verified notification that matches nothing returns instead of throwing.**
0.1 raised `DriveNotificationInvalidError`, so the route answered `400`.
Answering an unmatched notification differently from a matched one is an oracle
for which accounts a deployment holds, so it is now `reason: 'unmatched'`,
`shouldSync: false`, and the same `200` a matched one gets.

```ts
// 0.1.x — this catch no longer fires for an unmatched notification
try {
  await handleNotification(drives, input, options)
} catch {
  return reply.status(400)
}

// 0.2.0 — a bad *signature* still throws; "nothing matched" is an outcome
const outcome = await handleNotification(drives, input, options)
if (outcome.reason === 'unmatched') log.info('notification for no connection of ours')
```

`DriveNotificationInvalidError` is unchanged and still thrown for a notification
that cannot be *trusted* — a bad signature, a missing channel secret, a body
that is not a notification at all. Only the matched/unmatched distinction moved.
If you use `driveRoutes()`, this is already handled for you.

**3. `DriveRemoval.externalId` is optional.** A Dropbox deletion carries no id
at all, only a path, so a reported removal may have `path` and no `externalId`
(and therefore no `targetId`, which the engine resolves from the ledger by id).

```ts
// 0.1.x
onRemoved: async ({ externalId, targetId }) => archive(externalId, targetId)

// 0.2.0
onRemoved: async ({ externalId, path, targetId }) => {
  if (externalId !== undefined) return archive(externalId, targetId)
  // Dropbox: correlate against whatever you stored at import time.
  return archiveByPath(path!)
}
```

On Google and Microsoft `externalId` is still always present — but it is now
*typed* optional, so an existing call site needs a guard.

## Mental model

Three things that must not be confused:

| Piece | What it is | Owned by |
| --- | --- | --- |
| A **connection** | one tenant's consent to one account at one provider, with its own label, root, credentials and sync cursor | `@basaltkit/drives` |
| An **item** | a file or folder **at the provider**, identified by its `externalId` | the provider |
| The **import** | what your app ended up with — a `@basaltkit/files` record, or a row of your own | your app |

A tenant may hold **many connections to the same provider**. "Drive Finance" and
"Drive HR" are two rows with `provider: 'google'`, independent credentials, roots
and cursors. Nothing is keyed by `(tenant, provider)`, which is what makes this
fall out of the model instead of being a special case.

## Setup

```ts
import { drivesPlugin, DRIVES } from '@basaltkit/drives'

const app = createApp({
  plugins: [
    tenancyPlugin({ /* … */ }),
    // Sniffing matters here: a provider's declared content type is whatever
    // the uploading client claimed, so it is never trusted.
    filesPlugin({ disk: 'documents', validate: { sniff: true } }),
    drivesPlugin({
      providers: [/* an adapter — see "Writing an adapter" */],
      keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
      secret: env.APP_SECRET,
      store: prismaDriveConnectionStore(db),
      ledger: prismaDriveImportLedger(db),
    }),
  ],
})
```

`keys` is a **ring**. The first entry seals new credentials; every other entry
stays readable, so rotating is a rolling change — prepend the new key, let
connections re-seal as they refresh, and drop the old key once nothing
references it. Use `secret()` from `@basaltkit/env` so a placeholder cannot
reach production:

```ts
export const env = defineEnv({
  DRIVES_ENCRYPTION_KEY: secret({ minLength: 32 }),
})
```

## Routes

`driveRoutes()` serves the connect flow and **one** notification endpoint that
answers all three vendors' handshakes. It is built with `route()` from
[`@basaltkit/http`](/guide/adapters), so the same definitions run unchanged on
Fastify, Express and Hono.

```ts
import { driveRoutes } from '@basaltkit/drives'

fastifyPlugin({
  routes: driveRoutes({
    redirectUri: (provider) => `https://app.example.com/drives/${provider}/callback`,
    successRedirect: '/settings/drives',
    notifications: {
      connections: ({ accountIds }) => db.driveConnections.byAccount('dropbox', accountIds ?? []),
      onChange: (connections) => Promise.all(connections.map((c) => SyncDrive.dispatch(c))),
    },
  }),
})
```

| Route | What it does |
| --- | --- |
| `GET /drives/:provider/connect` | 302 to consent, with the browser binding in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie scoped to the flow |
| `GET /drives/:provider/callback` | verifies state + binding, exchanges the code, stores the connection, clears the cookie |
| `GET /drives/:provider/notifications` | answers a handshake challenge as `text/plain` with `nosniff` |
| `POST /drives/:provider/notifications` | verifies, then schedules; always answers `200 {received:true}` |

The connect routes default to `meta: { auth: true }` — starting an authorization
on behalf of a tenant is not an anonymous action. The notification routes never
carry guard metadata: the provider has no session.

### The raw body

The notification route needs the **untouched** request bytes: a signature covers
the bytes that arrived, so a re-serialised body is a *different message*.

It declares `body: rawBody({ maxBytes })` from `@basaltkit/http`, so **Fastify,
Express and Hono all hand it the exact octets with no wiring at all** — no
content-type parser, no `verify` hook, no middleware. The bytes are read after
the pipeline's guards have run, capped at 64 KiB by default
(`notifications.maxBytes`), and never parsed by anything.

```ts
fastifyPlugin({ routes: driveRoutes({ /* … */ notifications: { /* … */ } }) })
// …and the same routes, unchanged, on expressPlugin() and honoPlugin().
```

See [Raw request bodies](/guide/adapters#raw-request-bodies-webhook-signatures)
for what each adapter does. There is one caveat, on Express only: if you bring
your own app with `express.json()` already mounted, body-parser consumes the
stream before any route runs — add
`app.use(express.json({ verify: captureRawBody }))` (from `@basaltkit/express`),
or the common `req.rawBody = buffer` convention, which is honoured too.

**Handshakes never need a body.** Dropbox's challenge arrives on
`GET ?challenge=`; Microsoft Graph's arrives on a `POST ?validationToken=` with
**no body at all**, sent before the subscription exists. One route answers both
shapes, and it answers a query-borne challenge *before* it asks for any bytes —
without consulting a connection, without spending a replay token, and capped and
sanitised (`text/plain`, `nosniff`, 256 characters, control and bidi characters
stripped). Demanding the bytes first would turn Graph's validation into
`subscriptionValidationFailed` on `watch()`, which sends the operator hunting
the subscription instead of the body parser.

When a delivery that **declared** bytes cannot produce them the route **fails
closed** rather than reconstructing a message: that is the whole point. For a deployment that
terminates the request somewhere the neutral layer cannot see, supply them
yourself with `notifications.rawBody: (request) => Buffer` — never by
re-serialising a parsed object.

## Connecting an account

`driveRoutes()` above does this for you. The facade underneath is public too,
for an app that wants its own routes: two steps, with one value carried between
them in a cookie.

```ts
// 1. Where to send the browser.
const { url, binding } = drives.startAuthorization({
  provider: 'google',
  redirectUri: 'https://app.example.com/drives/google/callback',
})
reply.setCookie('drive_binding', binding, { httpOnly: true, sameSite: 'lax', secure: true })
reply.redirect(url)
```

```ts
// 2. At the callback.
const connection = await drives.completeAuthorization({
  provider: 'google',
  code: query.code,
  state: query.state,
  binding: request.cookies['drive_binding'],
  redirectUri: 'https://app.example.com/drives/google/callback',
  label: 'Drive Finance',
})
```

::: tip Why the cookie
The `state` alone is replayable: an attacker who starts their own flow can open
the resulting callback URL in a victim's browser and attach **their** account to
the victim's tenant. The `binding` defeats that, because the state only verifies
against a value in the victim's own cookie jar. The state also carries the
tenant, so it cannot be replayed into a different tenant, and it is single-use.
:::

Listing never exposes credentials:

```ts
await drives.list()                      // current tenant's connections
await drives.list({ provider: 'google' })
await drives.list({ status: 'invalid' }) // needs the user to reconnect
```

Disconnecting **revokes at the provider by default** — deleting our row while
the grant lives on does not achieve what "disconnect" means:

```ts
await drives.disconnect(connection.id)
await drives.disconnect(connection.id, { revoke: false })  // local only
```

The row and its sealed credentials always go; what varies is whether the grant
survived at the provider, which `drive:disconnected` states as `revocation`
rather than leaving you to infer it from a boolean:

| `revocation` | Meaning | What to do |
| --- | --- | --- |
| `revoked` | the provider accepted it | nothing — the grant is gone |
| `skipped` | you passed `{ revoke: false }` | nothing |
| `unsupported` | the adapter has no revocation endpoint and never will (Microsoft Graph — see below) | tell the user to withdraw consent in their account portal |
| `failed` | we asked and the provider did not answer | **retry** — the grant may still be live |

`revoked: boolean` is still there and still means `revocation === 'revoked'`,
but it cannot separate the last two, and those are the two that need different
actions from an operator.

## Connecting Dropbox

`@basaltkit/drives-dropbox` is the first real adapter, and the reference for
writing one.

```bash
pnpm add @basaltkit/drives-dropbox
```

```ts
import { dropboxDrive } from '@basaltkit/drives-dropbox'

drivesPlugin({
  providers: [
    dropboxDrive({
      clientId: env.DROPBOX_APP_KEY,
      // Dropbox has no separate webhook secret: the app secret signs
      // notifications too.
      clientSecret: env.DROPBOX_APP_SECRET,
    }),
  ],
  keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
  secret: env.APP_SECRET,
})
```

In the [Dropbox App Console](https://www.dropbox.com/developers/apps):

1. **Redirect URI** — `https://app.example.com/drives/dropbox/callback`, byte
   for byte what `driveRoutes({ redirectUri })` produces.
2. **Permissions** — `account_info.read`, `files.metadata.read`,
   `files.content.read`, plus `files.content.write` if you upload.
3. **Webhook URI** — `https://app.example.com/drives/dropbox/notifications`.
   Dropbox verifies it with a `GET ?challenge=…` **the moment you press Save**,
   before any tenant has connected anything; the route answers that without
   looking any connection up.

### Four things Dropbox does differently

Each one changed the contract rather than being papered over, and the Google and
Microsoft adapters will land on the other side of each.

**The change feed starts at the folder, not at "now."** `files/list_folder`
returns the first page of entries *and* the cursor, and `/continue` carries on
into changes — backfill and delta are one continuum. The adapter declares
`deltaIncludesExisting: true`. Google Drive's `changes.getStartPageToken` is the
opposite and must declare `false`, which makes the engine run a full listing
pass before its first delta run — otherwise a first sync imports nothing at all.

**A deletion has no id.** Dropbox reports `{".tag":"deleted", path_display}`,
because the id belonged to the thing that no longer exists. So a removal carries
`externalId` **or** `path`:

```ts
onRemoved: ({ externalId, path, targetId }) => {
  // `targetId` resolves only for an id-based removal — the ledger is keyed by
  // id. For Dropbox, correlate on the path you stored at import time;
  // `filesSink` records it as `metadata.drivePath`.
  return targetId ? archiveDocument(targetId) : archiveByPath(path!)
}
```

**There is no subscription, and no secret of ours.** The webhook URI is
registered once per *app* and fires for every user who authorized it, so
`watchConnection()` reports `DRIVE_UNSUPPORTED` and a notification identifies a
connection by the Dropbox **account id** it names. One notification can concern
several connections — the same account connected twice, or by two tenants — so
`outcome.connections` is a list. The lookup by account is necessarily
cross-tenant, and safe because the id came from a payload the app secret signed,
never from the caller; it stays **your** query, so the framework never scans a
table on an unauthenticated request.

**The rate-limit hint is often in the body.** Dropbox answers `429` with
`{"error":{"retry_after":300}}` and frequently no `Retry-After` header at all.
The adapter declares `retryAfterFromBody` and the engine applies it under its
own ceiling.

### Limitations

- Uploads over **150 MB** need `files/upload_session/*`, which is not
  implemented; larger files are refused up front with
  `DRIVE_CONTENT_TOO_LARGE`.
- Dropbox Business **team spaces** are not addressed (`Dropbox-API-Path-Root`
  and `Dropbox-API-Select-User` are not sent).
- **Export-only items** (Paper docs) surface with `exportOnly: true`;
  `files/export` is not wired.
- No `externalUrl`: Dropbox metadata carries no web link, and manufacturing one
  would mean creating a share.

## Connecting Google Drive

`@basaltkit/drives-google` is the second adapter, and the one the contract was
most at risk of flattening.

```bash
pnpm add @basaltkit/drives-google
```

```ts
import { googleDrive } from '@basaltkit/drives-google'

drivesPlugin({
  providers: [
    googleDrive({
      clientId: env.GOOGLE_CLIENT_ID,
      // Unlike Dropbox this is NOT a webhook key: Google signs nothing, and a
      // notification is authenticated by the channel token the engine chose.
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
  secret: env.APP_SECRET,
})
```

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. **Enable the Google Drive API** for the project.
2. **OAuth client** of type *Web application*, redirect URI
   `https://app.example.com/drives/google/callback` — byte for byte what
   `driveRoutes({ redirectUri })` produces.
3. **Scopes** — `drive.readonly` by default; uploading needs `drive.file` or
   `drive`. `drive.readonly` and `drive` are *restricted* scopes: a public app
   needs Google's verification and an annual security assessment, an internal
   Workspace app does not.
4. **Push notifications** (optional) — the notification URL's domain must be
   verified in Google Search Console and registered in the project. Google has
   no challenge handshake; it simply refuses to create the channel.

### Four things Google does differently

**The change feed starts at "now", so the first sync has to backfill.**
`changes.getStartPageToken` is the token for the *future*: the corpus that
already exists never appears in `changes.list`. The adapter declares
`deltaIncludesExisting: false`, and the engine answers by taking the token
first, running a full listing pass, and only then following the feed — that
ordering is the correctness argument, because anything that changes during the
listing is re-delivered by the first delta run and the ledger absorbs it.
Declaring it the other way is not a performance bug: the first sync reports
success, imports **nothing**, and persists a cursor that guarantees the existing
files are never seen again.

**A throttle is a `403`, not a `429`.** Google answers
`{"error":{"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded"}]}}`
with a 403 status. The adapter reads the reason and raises
`DRIVE_RATE_LIMITED`, keeping `DRIVE_ACCESS_DENIED` for a genuine permission
refusal. The difference is not cosmetic — `DRIVE_ACCESS_DENIED` is terminal, so
mapping by status code alone permanently fails a job over a condition that
clears itself in a second.

**`changes.list` is account-wide, not folder-scoped.** There is one feed per
account; it cannot be scoped to a folder. A connection confined to a `rootId`
therefore filters **client-side**, walking each changed file's `parents` upwards
with one metadata read per folder it has not already seen in that call. The cost
is real and bounded by `ancestryMaxLookups`, which fails loudly rather than
guessing. Out-of-scope changes are dropped before they become a `DriveChange`,
so nothing about another folder reaches `onRemoved`, your hooks or the ledger.
The same absence of a recursive query is why a scoped **listing** walks the
subtree folder by folder instead of returning one level.

A hard deletion is the one case this cannot scope: `{fileId, removed: true}`
arrives with no file resource at all, so there is nothing left to test the
ancestry of. Those are dropped by default for a scoped connection —
`includeUnscopedRemovals: true` forwards them, and then correlating them is
yours, against the ledger that actually knows which ids you imported. A trash
(the ordinary Drive delete) carries the full resource and is scoped normally.

**Google-native documents have no bytes.** A Doc, Sheet or Slide has no
`md5Checksum`, no `size`, and `files.get?alt=media` refuses it. They surface
with `exportOnly: true` and their mime type in `raw`, and `download` refuses
them rather than exporting to a format you never asked for. `importItem` skips
them under `copy` with `reason: 'no-content'`, so they do not become permanently
failing jobs; under `reference` your sink still sees them and can run
`files.export` itself.

### Renewing a subscription

Google caps a channel's life. `DriveWatch.expiresAt` carries Google's own
`expiration` — never the TTL you asked for — and renewal is **your** job,
because re-subscribing is provider traffic the framework will not spend on your
behalf:

```ts
defineReconciler({
  name: 'drive-watch-renewal',
  every: '1h',
  find: () => connectionsWithWatchExpiringWithin('24h'),
  redispatch: (c) =>
    watchConnection(drives, c.id, {
      tenantId: c.tenantId,
      notificationUrl: 'https://app.example.com/drives/google/notifications',
    }),
}).schedule(scheduler)
```

`watchConnection` generates a new secret each time, so a renewed channel cannot
be addressed with the old one.

### The redirect, and why the allowlist has a dot in it

`files.get?alt=media` answers `302` to a signed URL on
`*.googleusercontent.com`. The adapter allowlists it as a leading-dot
**suffix**, which matches `doc-04-7g-docs.googleusercontent.com` and refuses
both `googleusercontent.com` itself and `evilgoogleusercontent.com` — the
look-alike a naive `endsWith` would wave through. The guarded fetch re-runs the
allowlist, the SSRF validation and the IP pin on every hop, and the adapter
never sees the signed URL, so it cannot log it. That URL is a bearer credential
for the file.

### Limitations

- Uploads over **5 MB** need `uploadType=resumable`, which is not implemented;
  larger files are refused up front with `DRIVE_CONTENT_TOO_LARGE`.
- **Shared drives** are not addressed as a corpus: `supportsAllDrives` is sent
  everywhere, so ids inside one resolve, but a connection scoped to a shared
  drive (with its own change feed) is not wired.
- **No `path`** — Drive is a graph and publishes none, so removals correlate on
  `externalId`.
- **Service accounts / domain-wide delegation** are not implemented; obtain the
  tokens yourself and use `drives.connect()`.
- `invalid_grant` on refresh means revoked consent, a deleted OAuth client
  **or** a grant unused for six months (seven days while the app is in
  "testing"). Google sends the same string for all three, so the connection is
  marked `invalid` and the tenant is asked to reconnect — which is the only
  available action in any of the three cases.

## Connecting OneDrive / SharePoint

`@basaltkit/drives-microsoft` is the Microsoft Graph adapter, and it lands on
the **other side** of nearly every difference Dropbox exposed.

```bash
pnpm add @basaltkit/drives-microsoft
```

```ts
import { microsoftDrive } from '@basaltkit/drives-microsoft'

drivesPlugin({
  providers: [
    microsoftDrive({
      clientId: env.MS_CLIENT_ID,
      // A web app registration has a secret; a public client uses PKCE alone.
      // It is NOT a webhook key: Graph does not sign notifications at all.
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
2. **API permissions** — delegated Graph permissions. `offline_access` is what
   makes Entra ID return a refresh token at all; `Files.Read` reads the user's
   own OneDrive, `Files.Read.All` any drive they can reach, and a **SharePoint**
   library needs `Files.Read.All` **and** `Sites.Read.All`. Writing back needs
   the `ReadWrite` variants.
3. **Nothing to register for webhooks.** Subscriptions are created at runtime and
   Graph validates the notification URL while creating each one.

**Single-tenant or multi-tenant.** `tenant: 'common'` accepts any Microsoft
account; `organizations` only work/school ones; a GUID or verified domain pins
one Entra tenant. If the app registration is single-tenant you must set the
tenant — the `common` endpoint issues a token the registration then refuses, and
that surfaces as `AADSTS50194` at the callback, after the user consented. If it
is multi-tenant, expect admin consent per customer tenant (`consent_required`
until an administrator approves), conditional-access policies you do not control
(a refresh can come back `interaction_required`, which marks the connection
`invalid` and needs a human), and one client secret that now reaches every
customer tenant.

**Which drive a connection means, said out loud.** Graph has three plausible
answers and a bare id cannot distinguish them, so the target lives in `rootId`:

```ts
import { microsoftRoot } from '@basaltkit/drives-microsoft'

microsoftRoot({})                                  // '/me/drive/root'
microsoftRoot({ driveId })                         // '/drives/{id}/root'
microsoftRoot({ siteId })                          // a site's default library
microsoftRoot({ siteId, itemId })                  // one folder inside it
```

`rootId` reaches the adapter from `?rootId=` on the connect URL, so it is
caller-controlled and becomes part of a Graph path: every segment is validated,
and `/`, `?`, `#`, `%`, `.`, `..` and whitespace are refused with
`DRIVE_ACCESS_DENIED`. A `folderId` may narrow a call to a folder but never name
another drive.

### Four things Microsoft does differently

**The refresh token rotates, every time.** The old one dies the instant a new one
is issued. Nothing in the adapter works around that; the engine's
compare-and-set persists the new one. The subtle part is that a *concurrent*
refresh produces `invalid_grant` — byte for byte what a **revoked** grant
produces — so taking it at face value would mark a healthy connection `invalid`
at random under load. The engine re-reads the row before condemning it and
adopts whatever the winner stored.

**Disconnect means less here.** Graph has no per-application revoke endpoint, so
the adapter omits `revoke` and `drives.disconnect()` emits `revoked: false`:

```ts
hooks.on('drive:disconnected', ({ provider, revocation }) => {
  // Branch on `revocation`, never on `revoked` alone: on OneDrive the boolean
  // is always false because there is nothing to call, and on Dropbox or Google
  // it is false when the call simply did not get through — which is worth
  // retrying, and is the opposite instruction.
  if (revocation === 'unsupported') tellTheUserWhereToRemoveConsent(provider)
  if (revocation === 'failed') scheduleRevocationRetry(provider)
})
```

`revocation` is `'revoked' | 'skipped' | 'unsupported' | 'failed'`; see
[Disconnecting](#connecting-an-account). The local credentials are deleted in
every case — the distinction is only about the grant's fate at the provider,
which is exactly what a deletion record has to be able to state.

**Pagination is a URL, not a token.** `@odata.nextLink` and `@odata.deltaLink`
are complete URLs. They are wrapped in an opaque cursor so Graph's paging state
never lands in your database as something fetchable, and unwrapped only after
checking they still point at Graph — before the guarded fetch re-validates them
for real. A provider-supplied URL that the framework then fetches is exactly the
case the guard exists for.

**The download URL is a bearer credential.** `@microsoft.graph.downloadUrl` is
pre-signed and lives on a CDN host, and `/content` redirects to the same place.
So listings `$select` it away (it is never in `DriveItem.raw`, a sink or a log),
`download` fetches it with **no** `Authorization` header, the allowlist entries
are `.suffix` and never bare parents, and a failure from the content host is
reported without its body because CDN error pages quote the request URL.

### Subscriptions expire — renewal is yours

`watchConnection()` creates a Graph subscription with the engine's secret as
`clientState`, and surfaces `expiresAt`. Graph never renews it, and a lapsed
subscription is silent: notifications simply stop.

```ts
defineReconciler({
  name: 'drive-watch-renewal',
  every: '6h',
  find: async () =>
    (await drives.list({ tenantId })).filter((c) => c.provider === 'microsoft' && c.watching),
  redispatch: (c) =>
    watchConnection(drives, c.id, {
      tenantId: c.tenantId,
      notificationUrl: 'https://app.example.com/drives/microsoft/notifications',
    }),
}).schedule(scheduler)
```

Graph validates the notification URL **while** `POST /subscriptions` is in
flight, with a `validationToken` it expects echoed as `text/plain` within
seconds. The shared notification route already answers that — the same one that
answers Dropbox's `GET ?challenge=`. A `watch()` that fails with
`subscriptionValidationFailed` means the route is not reachable from the
internet.

One delivery can batch entries for several subscriptions that share a URL, so
`outcome.connections` is a list here too.

### Limitations

- Uploads over **4 MB** need `createUploadSession`, which is not implemented;
  larger files are refused up front with `DRIVE_CONTENT_TOO_LARGE`. This is the
  lowest ceiling of the three providers.
- A **subscription covers the whole drive**, not a folder: Graph only accepts a
  drive root as a `driveItem` subscription resource. It costs a wasted sync,
  never a wrong one.
- **Checksums differ by account type** — `quickXorHash` on Business and
  SharePoint, `sha1Hash`/`sha256Hash` on personal. Labelled honestly, and
  comparable only within one provider and one account type.
- **Items with no downloadable bytes** surface with `exportOnly: true` — a
  OneNote notebook (a `package` facet), and a "Shared with me" shortcut (a
  `remoteItem` facet) whose bytes live in another drive. `importItem` skips
  those as `no-content`; without the flag each one would be a job that fails and
  re-enqueues for ever.
- **Cross-drive shared items** are otherwise out of scope: a connection is
  confined to one drive. Connect the owning drive instead.

## Importing

### The pipeline

Sync **discovers**; the queue **downloads**. An HTTP request never blocks on a
drive of any size.

```ts
import { defineJob } from '@basaltkit/queue'
import { filesSink, importItem, syncConnection, type DriveImportTask } from '@basaltkit/drives'

export const ImportDriveItem = defineJob<DriveImportTask>({
  name: 'drives.import',
  attempts: 3,
  backoff: { type: 'exponential', delay: '30s' },
  async handle(task) {
    await importItem(drives, task.connectionId, task.item, filesSink(files), {
      strategy: task.strategy,
    })
  },
})

// One sync pass: walks the change feed and enqueues. Downloads nothing.
const result = await syncConnection(drives, connection.id, {
  enqueue: (task) => ImportDriveItem.dispatch(task),
  filter: (item) => item.name.endsWith('.pdf'),
  // A removal carries `externalId` or `path` — see "Connecting Dropbox".
  onRemoved: ({ externalId, path, targetId }) => archiveDocument(targetId),
})
// → { seen, enqueued, skipped, removed, truncated, mode: 'delta' | 'listing' }
```

`maxItems` (default 1000) and `maxPages` (default 50) are **hard ceilings**, not
hints. The first sync of a mature Google Drive can be hundreds of thousands of
items, so a run that stops at a ceiling has to be able to carry on — and whether
it can depends on which of three shapes the run had:

| Run | Resumes? | Why |
| --- | --- | --- |
| **Delta** (`mode: 'delta'`) | yes | the provider's cursor is persisted after every page |
| **Backfill** — the listing pass an adapter with `deltaIncludesExisting: false` needs (Google) | yes | the engine parks its own resume point in `cursor`, continues the enumeration on the next run, and switches to the feed only once the walk has finished |
| **Plain listing** — an adapter with no change feed at all | **no** | there is nothing to resume from: the walk restarts from the top and the ledger absorbs the repetition |

The third row is the one to design around. Against an adapter with no `delta`, a
corpus larger than `maxItems` is never fully walked, so raise the ceilings or
shard with `filter` rather than expecting the next run to catch up.

The backfill's resume point is the engine's own value, not a provider cursor —
it holds the delta cursor taken **before** the first listing page, which is what
keeps the whole multi-run backfill at-least-once. Treat `connection.cursor` as
opaque, which is what it has always been.

### Keeping it running

Use `defineReconciler` from [`@basaltkit/scheduler`](/guide/scheduler) — it
already solves overlap guarding and the cross-replica lease:

```ts
import { defineReconciler } from '@basaltkit/scheduler'
import { dueConnections } from '@basaltkit/drives'

defineReconciler({
  name: 'drive-sync',
  every: '15m',
  find: () => dueConnections(drives, { tenantId, staleForMs: 15 * 60_000 }),
  redispatch: (connection) => SyncDrive.dispatch({ connectionId: connection.id }),
}).schedule(scheduler)
```

### Dedup

The ledger is consulted **before** the download, keyed by
`(tenant, connection, externalId)` and compared on a content version: the
provider's revision first, then its checksum, then `updatedAt` + size.

That ordering is deliberate — `updatedAt` also moves when a file is renamed or
re-shared, and re-downloading a gigabyte because someone renamed a folder is a
bill, not a feature. For a nightly sync over a folder that rarely changes, this
is the difference between a few kilobytes and the whole corpus, every night.

::: warning A checksum is not portable
`DriveChecksum` carries an `algorithm` because the vendors publish different
functions of different inputs, and the value alone is meaningless across them:

| Provider | Algorithm | Caveat |
| --- | --- | --- |
| Dropbox | `dropboxContentHash` | a block-tree construction, **not** the file's SHA-256 |
| Google | `md5` | binary files only — a native Doc, Sheet or Slide has no checksum and no `size` |
| Microsoft | `quickXorHash` *or* `sha1`/`sha256` | **depends on the account type**, so two connections of the same adapter can disagree for identical bytes |

So compare `algorithm` before `value`, and do not dedup on a checksum across
connections without checking both. `contentVersion()` already does: it prefixes
the algorithm onto the version string, so two algorithms cannot collide into
"unchanged". If you want one digest comparable everywhere, hash the bytes you
imported — `@basaltkit/files` computes a SHA-256 as they stream past.
:::

```ts
await drives.forgetImports(connection.id)  // next sync re-imports everything
```

## Copy or reference

Two first-class strategies. `reference` is not a degraded `copy`.

| | `copy` | `reference` |
| --- | --- | --- |
| Bytes | downloaded into your storage | **nothing is downloaded** |
| Availability | survives deletion or un-sharing at the provider | disappears with the original |
| Retention | your policy applies | the provider's does |
| Auditability | can prove what the document said | can prove only that it was seen |
| Revocation | revoking the connection leaves the copy | revoking the connection makes it unreachable |
| Cost | storage + egress | zero |
| Data protection | you become a controller of that data | you hold metadata only |

```ts
await importItem(drives, id, item, mySink, { strategy: 'reference' })
```

Under `reference` the sink receives no `content` and **no byte is fetched** —
that is the guarantee, not a side effect.

## Writing back

`drives.upload()` exists, and **every adapter has a low, hard size ceiling**.
Only single-request uploads are implemented; the alternative on all three
vendors is a multi-call resumable session with its own chunking and resumption:

| Adapter | Ceiling | What a larger file would need |
| --- | --- | --- |
| `@basaltkit/drives-microsoft` | **4 MB** | `createUploadSession` |
| `@basaltkit/drives-google` | **5 MB** | `uploadType=resumable` |
| `@basaltkit/drives-dropbox` | **150 MB** | `files/upload_session/*` |

Anything larger is refused with `DRIVE_CONTENT_TOO_LARGE`. **Pass
`DriveUploadInput.size` when you know it**: with it the refusal happens before a
socket is opened, without it the byte cap trips part-way through and the request
is destroyed — the same refusal, after the bytes have been on the wire. Nothing
truncates silently, and `size` is never trusted in place of the cap, so a source
that under-reports is still caught by the bytes that actually flow.

## Custom sinks

`DriveSink` is the seam between the framework and your domain. `filesSink`
covers the common case; anything else is a function:

```ts
const documentSink: DriveSink = async ({ item, content, connection, version }) => {
  const file = await files.upload(content!.stream, { name: item.name, contentType: content!.contentType! })
  const document = await db.document.create({
    data: { fileId: file.id, matterId: matterFor(item.path), source: connection.label, version },
  })
  return { targetId: document.id }
}
```

## Writing an adapter

Only `name`, `allowedHosts`, `authorization`, `list` and `download` are
required; everything else degrades honestly, reporting `DRIVE_UNSUPPORTED`
rather than silently doing nothing.

```ts
export const myDrive = (keys: Keys): DriveProvider => ({
  name: 'mydrive',
  allowedHosts: ['api.mydrive.com', '.files.mydrive.com'],
  authorization: {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) => `https://…`,
    exchange: async ({ code, redirectUri, codeVerifier, fetch }) => ({ /* DriveTokens */ }),
    refresh: async ({ refreshToken, fetch }) => ({ /* DriveTokens */ }),
  },
  async list(session, { folderId, cursor }) {
    const res = await session.fetch(`https://api.mydrive.com/files?…`)
    const json = await res.json<ListResponse>()
    return { items: json.items.map(toDriveItem), cursor: json.next ?? undefined }
  },
  async download(session, item) {
    const res = await session.fetch(`https://api.mydrive.com/files/${item.externalId}/content`)
    return { stream: res.body, contentType: res.headers['content-type'] }
  },
})
```

Two rules the engine enforces for you:

- **An adapter never sees the refresh token.** `session` carries one short-lived
  access token, already refreshed if it was near expiry. A bug inside an adapter
  cannot exfiltrate the long-lived credential or reach another tenant's rows.
- **An adapter never calls `fetch` itself.** `session.fetch` is
  host-allowlisted, SSRF-validated, IP-pinned, byte-capped and timed out.

`refresh` should throw `DriveCredentialsInvalidError` when the provider says the
grant is gone (`invalid_grant`, revoked consent). That is terminal: the engine
marks the connection `invalid` and stops, rather than retrying from every queued
job. Any other error is treated as transient — and in particular, an
`invalid_client` is **your** misconfiguration, not the tenant's revocation, so
it must not be reported as one.

Four optional members exist because the vendors genuinely differ. Declaring them
is how an adapter tells the engine which vendor it is:

| Member | Declare it when |
| --- | --- |
| `deltaIncludesExisting` | the cursor from `startDelta` replays what already exists (Dropbox, Microsoft Graph). The default `false` makes the engine run a listing pass first, so an adapter that forgets costs extra metadata reads instead of losing a tenant's files. |
| `retryAfterFromBody` | the vendor puts its rate-limit hint somewhere other than `Retry-After` (Dropbox). |
| `DriveNotificationResult.accountIds` | notifications identify a connection by a provider account rather than by a secret you chose (Dropbox). |
| a removal's `path` | deletions are reported by path because the vendor gives no id for them (Dropbox). |
| `DriveItem.exportOnly` | the vendor has items with no downloadable bytes (Google's native Docs, Dropbox's Paper docs). `importItem` skips them under `copy` with `reason: 'no-content'` rather than failing that job on every run for ever. |

Throw `DriveCursorResetError` (`DRIVE_CURSOR_RESET`) when the vendor
invalidates a stored cursor —
Dropbox's `409 reset/`, Graph's `410 resyncRequired`, an aged-out Google
`pageToken`. All three do this, and the cursor is *persisted*: mapped to any
other error, one expiry makes every future sync of that connection fail
identically for ever, and no retry policy can help. The engine answers by
dropping the cursor and reporting `reset: true`; the next run re-primes the feed
and the ledger absorbs the repetition, so a reset costs metadata reads rather
than a re-download.

### Testing an adapter

```ts
import { FakeDriveProvider } from '@basaltkit/drives/testing'

const fake = new FakeDriveProvider({ files: [{ externalId: 'f1', name: 'a.pdf' }] })
fake.expireAccessTokens()      // force a refresh
fake.rateLimitNextCalls = 2    // provoke backoff
fake.grantRevoked = true       // provoke fail-closed invalidation
fake.edit('f1', 'new content') // provoke a re-import
fake.remove('f1')              // provoke a removal
```

The fake is the executable specification of the contract: every behaviour the
engine claims to handle can be provoked deterministically, with no network.

## Multi-tenancy

Isolation is enforced in the **data layer**, not only in routes:

- `tenantId` is an explicit argument on every store method, so an unscoped query
  is not expressible.
- The facade re-filters everything a store returns, so a custom or buggy store
  cannot widen a result set.
- An ambient tenant in the context always wins. An explicit `tenantId` is
  honoured only when it agrees — so a route that forwards `?tenantId=` from the
  client gets `DRIVE_TENANT_MISMATCH`, not another tenant's data.

A connection belonging to another tenant reports **404, never 403**: telling a
caller "it exists but is not yours" turns connection ids into an oracle.

## Notifications

Where a provider supports push, subscribe and verify:

`driveRoutes({ notifications })` is the supported way to serve this — it already
answers the handshakes, enforces the body cap, and keeps the responses uniform.
The engine underneath is public for an app with its own route:

```ts
// Only where the provider has a per-connection subscription to register.
// Dropbox does not: its webhook is app-wide, so this reports DRIVE_UNSUPPORTED.
const watch = await watchConnection(drives, connection.id, {
  notificationUrl: 'https://app.example.com/drives/google/notify',
})

// In the route — keep the RAW body, signature schemes sign bytes, not objects.
const outcome = await handleNotification(drives, { method, headers, query, body: rawBuffer }, {
  provider: 'google',
  // An array, or a resolver: `({ accountIds }) => …` for a vendor whose
  // notification names accounts rather than echoing a secret you chose.
  connections: await connectionsForThisRoute(),
  replayGuard,
})

if (outcome.challenge) return reply.type('text/plain').send(outcome.challenge)
// A list: one notification can concern several connections.
for (const connection of outcome.connections) {
  if (outcome.shouldSync) await SyncDrive.dispatch({ connectionId: connection.id })
}
```

A verified notification that matches **nothing** is not an error: it comes back
as `reason: 'unmatched'` with an empty `connections`, and the route answers it
exactly as it answers a match. Answering differently would tell an
unauthenticated caller which accounts and channels a deployment holds.

::: warning "Verified" is not one guarantee
The engine reports every verified notification the same way, and `shouldSync`
looks identical whichever vendor sent it. They are not equivalent:

| Vendor | What authenticates it | What that covers |
| --- | --- | --- |
| Dropbox | `X-Dropbox-Signature`, HMAC-SHA256 over the **raw body** under the app secret | the message itself |
| Google | `X-Goog-Channel-Token` — a secret *we* generated | the subscription; **the body is not covered** |
| Microsoft | Graph's `clientState` — a secret *we* generated | the subscription; **the body is not covered** |

Only Dropbox signs anything. That is why a Dropbox `accountIds` lookup may span
tenants (the id came from a signed payload) while a secret-matched result is
only ever matched against the connection holding that subscription.
:::

::: warning This endpoint is unauthenticated by construction
The provider calls it, so there is no session. The design bounds that rather
than pretending otherwise: **no provider sends the changed data**, so even a
perfectly forged notification can only cause your app to go and ask the
provider, with its own credentials, for its own tenant. The blast radius of a
spoof is a wasted sync — and that, rather than the strength of the secret, is
what makes the weaker two acceptable.

The `connections` candidate list is supplied by **you** and never scanned across
tenants by the framework, so an unauthenticated caller cannot address another
tenant's connection at all. For Dropbox that lookup is necessarily by account id
across tenants — safe because the id came from a payload the app secret signed,
and still your query rather than a framework table scan.
:::

## Security

- **`https:` only** by default. Widening is a separate, explicit
  `allowedSchemes` option, not a side effect of `allowPrivateHosts`.
- **Host allowlist per provider**, checked before DNS and again after every
  redirect. A `.suffix` entry matches subdomains only, so
  `evilgoogleusercontent.com` is refused.
- **SSRF + IP pinning.** Private, loopback, link-local (`169.254.169.254`),
  CGNAT, ULA and reserved addresses refused; every resolved address checked; the
  socket pinned so a DNS rebind cannot swap in an internal address.
- **Byte caps enforced mid-stream**, and no transparent decompression — so the
  cap applies to real bytes on the wire, which a decompression bomb cannot lie
  about.
- **Whole-exchange timeouts**, not connect-only.
- **Credentials encrypted with AES-256-GCM**, bound by AAD to their
  `(tenant, connection, provider)` — a blob moved to another row fails to
  decrypt rather than handing over credentials.
- **No token** in any log, error, `details` payload, hook payload or audit
  entry. That includes the URLs: a provider **download URL is itself a bearer
  credential** (`@microsoft.graph.downloadUrl`, Google's signed redirect
  target), so it is `$select`ed out of listings, kept out of `DriveItem.raw`,
  out of sinks and the ledger, and out of errors — a refusal from the guarded
  fetch names the **host and a fixed reason, never the URL**.

See [Security](/guide/security) and
[RFC 0002](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0002-basaltkit-drives.md).

## What this package does not do

It brings bytes across safely and records provenance. It has no opinion about
what a document **means**. Quarantine policy, OCR, extraction, classification,
approval workflow, retention, and which folder maps to which matter or client
are all yours. The seam is `DriveSink`.

Deletion at the provider is **reported, never acted on** — whether it should
delete your copy is a retention decision, and retention is a legal question.
