# @basaltkit/drives

Connect a tenant's **external file-storage accounts** — Google Drive,
OneDrive/SharePoint, Dropbox — to a Basalt app, and import documents from them.

The provider-specific part is small and lives in an adapter. Everything else is
here: many connections per tenant, OAuth credentials encrypted at rest with
refresh and rotation, provider-agnostic pagination, streaming download that
never buffers, incremental sync on a cursor, dedup, rate-limit backoff, and
inbound notification verification.

> **Status: `0.2.0`, unpublished.** The contract is implemented, tested against
> a full in-memory provider, and validated by the first real adapter
> (`@basaltkit/drives-dropbox`). See
> [RFC 0002](../../docs/rfcs/0002-basaltkit-drives.md), including the
> "phase 2a findings" section for what the first adapter changed.

## Upgrading from 0.1.x

Three things changed shape. Everything else in 0.1.x still compiles: the
optional members the adapters added (`deltaIncludesExisting`,
`retryAfterFromBody`, `accountIds`, `secrets`, `DriveRefreshInput.scopes`) are
additive, and an adapter that declares none of them keeps the 0.1 behaviour.

**1. A notification resolves to a *list* of connections.** One Dropbox delivery
names *accounts*, and one account can be connected several times — 0.1 returned
a single connection and would have silently synced one of them.

```ts
// 0.1.x
const outcome = await handleNotification(drives, input, { provider, connections })
if (outcome.shouldSync && outcome.connection) await sync(outcome.connection)

// 0.2.0
const outcome = await handleNotification(drives, input, { provider, connections })
if (outcome.shouldSync) for (const connection of outcome.connections) await sync(connection)
```

`connections` is always present and is `[]` when nothing matched. Grep for
`.connection` on an outcome — a half-migrated call site reads a field that no
longer exists rather than failing loudly.

**2. A verified notification that matches nothing returns instead of throwing.**
0.1 raised `DriveNotificationInvalidError` for it, so a route answered `400`.
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

**3. `DriveRemoval.externalId` is optional.** A Dropbox deletion carries no id
at all, only a path, so a reported removal may have `path` and no `externalId`
(and therefore no `targetId`, which is resolved from the ledger by id).

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

## Install

```bash
pnpm add @basaltkit/drives
```

Peers already in a Basalt app: `@basaltkit/core`. Pairs with
`@basaltkit/files` for the import target and `@basaltkit/queue` for the
pipeline — neither is a hard dependency.

## Quick start

```ts
import { drivesPlugin, DRIVES } from '@basaltkit/drives'
import { dropboxDrive } from '@basaltkit/drives-dropbox'

const app = createApp({
  plugins: [
    tenancyPlugin({ /* … */ }),
    filesPlugin({ disk: 'documents', validate: { sniff: true } }),
    drivesPlugin({
      providers: [dropboxDrive({ clientId: env.DROPBOX_APP_KEY, clientSecret: env.DROPBOX_APP_SECRET })],
      // First key seals; the rest stay readable, so rotation is a rolling change.
      keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }],
      secret: env.APP_SECRET,
      store: prismaDriveConnectionStore(db),
      ledger: prismaDriveImportLedger(db),
    }),
  ],
})
```

### Connect an account

`driveRoutes()` serves the whole flow — see [HTTP routes](#http-routes). The
facade underneath it is public too, for an app that wants its own routes:

```ts
const drives = app.container.get(DRIVES)

// 1. Send the browser to the provider. Put `binding` in an HttpOnly,
//    SameSite=Lax, Secure cookie — it is what ties the flow to this browser.
const { url, binding } = drives.startAuthorization({
  provider: 'dropbox',
  redirectUri: 'https://app.example.com/drives/dropbox/callback',
})

// 2. At the callback, hand the cookie back.
const connection = await drives.completeAuthorization({
  provider: 'dropbox',
  code, state,
  binding: request.cookies['drive_binding'],
  redirectUri: 'https://app.example.com/drives/dropbox/callback',
  label: 'Drive Finance',
})
```

A tenant may connect the **same provider many times** — "Drive Finance" and
"Drive HR" are two connections with independent credentials, roots and sync
cursors. Nothing in the model is keyed by `(tenant, provider)`.

### Import files

```ts
import { filesSink, importItem, syncConnection } from '@basaltkit/drives'

// Sync discovers work and enqueues it. It never downloads: an HTTP request
// cannot block on a drive of any size.
await syncConnection(drives, connection.id, {
  enqueue: (task) => ImportDriveItem.dispatch(task),
})

// The job downloads one item, streaming straight into @basaltkit/files.
export const ImportDriveItem = defineJob({
  name: 'drives.import',
  attempts: 3,
  backoff: { type: 'exponential', delay: '30s' },
  async handle(task) {
    await importItem(drives, task.connectionId, task.item, filesSink(files), {
      strategy: task.strategy,
    })
  },
})
```

## HTTP routes

`driveRoutes()` serves the connect flow and **one** notification endpoint that
answers all three vendors' handshakes. Built with `route()` from
`@basaltkit/http`, so the same definitions run unchanged on Fastify, Express and
Hono — there is a parity suite that boots all three.

```ts
import { driveRoutes } from '@basaltkit/drives'

fastifyPlugin({
  routes: driveRoutes({
    redirectUri: (provider) => `https://app.example.com/drives/${provider}/callback`,
    successRedirect: '/settings/drives',
    notifications: {
      // Dropbox's webhook is app-wide and names ACCOUNTS, so the lookup is
      // yours and keys off an id the signature already vouched for.
      connections: ({ accountIds }) => db.driveConnections.byAccount('dropbox', accountIds ?? []),
      // Enqueue. Never sync inline: Dropbox disables a slow webhook URI.
      onChange: (connections) => Promise.all(connections.map((c) => SyncDrive.dispatch(c))),
    },
  }),
})
```

| Route | What it does |
|---|---|
| `GET /drives/:provider/connect` | 302 to consent, with the browser binding in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie scoped to the flow |
| `GET /drives/:provider/callback` | verifies state + binding, exchanges the code, stores the connection, clears the cookie |
| `GET /drives/:provider/notifications` | answers a handshake challenge (Dropbox) as `text/plain` with `nosniff` |
| `POST /drives/:provider/notifications` | verifies, then schedules; always answers `200 {received:true}` |

The connect routes default to `meta: { auth: true }`. The notification routes
never carry guard metadata — the provider has no session.

### The raw body

The notification route needs the **untouched** request bytes: Dropbox (like
Microsoft Graph, Stripe and GitHub) signs the bytes that arrived, so a
re-serialised body is a *different message*.

It declares `body: rawBody({ maxBytes })` from `@basaltkit/http`, so **Fastify,
Express and Hono all hand it the exact octets with no wiring at all** — no
content-type parser, no `verify` hook, no middleware:

```ts
fastifyPlugin({ routes: driveRoutes({ /* … */ notifications: { /* … */ } }) })
// …and the same routes, unchanged, on expressPlugin() and honoPlugin().
```

The bytes are read after the pipeline's guards have run, capped at
`notifications.maxBytes` (64 KiB by default; past it, `413`), and never handed
to a parser. See the
[`rawBody()` per-adapter notes](../http/README.md#raw-request-bodies--rawbody).

One caveat, on Express only: an app you built yourself with `express.json()`
already mounted consumes the stream before any route runs. Add
`app.use(express.json({ verify: captureRawBody }))` (from `@basaltkit/express`) —
the widespread `req.rawBody = buffer` convention is honoured too.

**Handshakes never need a body.** Dropbox's challenge arrives on `GET
?challenge=`; Microsoft Graph's arrives on a `POST ?validationToken=` with **no
body at all**, sent before the subscription exists. One route answers both, and
it answers a query-borne challenge *before* it asks for any bytes — without
consulting a connection, without spending a replay token, and capped and
sanitised (`text/plain`, `nosniff`, 256 characters, control and bidi characters
stripped). Demanding the bytes first would turn Graph's validation into
`subscriptionValidationFailed` on `watch()`, which points the operator at the
subscription rather than at the body parser.

When a delivery that **declared** bytes cannot produce them the route **fails
closed** rather than reconstructing a message. For a deployment that terminates the request somewhere
the neutral layer cannot see, supply them yourself with
`notifications.rawBody: (request) => Buffer` — never by re-serialising a parsed
object.


## Reference

### `Drives`

| Method | What it does |
|---|---|
| `startAuthorization(input)` | Consent URL + the browser `binding` and `state` |
| `completeAuthorization(input)` | Verifies the callback, exchanges the code, stores the connection |
| `connect(input)` | Stores a connection from tokens you already hold (service account, device code) |
| `list(filter?)` | The tenant's connections, credentials stripped |
| `get(id, tenantId?)` | One connection, or `DRIVE_CONNECTION_NOT_FOUND` |
| `disconnect(id, options?)` | Revokes at the provider (default), unsubscribes, deletes the row |
| `forgetImports(id, tenantId?)` | Drops the dedup ledger so a later sync re-imports |
| `listItems(id, options?)` | One page of a folder |
| `getItem(id, externalId, options?)` | One item's metadata |
| `download(id, item, options?)` | The bytes, as a stream. Consume or destroy it |
| `upload(id, input, options?)` | Writes a file back, when the adapter supports it |
| `providerNames()` | Registered adapters |

### Functions

| Function | What it does |
|---|---|
| `importItem(drives, id, item, sink, options?)` | Dedup check, then stream through the sink |
| `filesSink(files, options?)` | A sink that streams into `@basaltkit/files` |
| `syncConnection(drives, id, options)` | One incremental sync pass; enqueues, never downloads |
| `dueConnections(drives, options)` | Connections a scheduled sweep should visit — feeds `defineReconciler` |
| `watchConnection(drives, id, input)` | Subscribes to provider push notifications |
| `driveRoutes(options)` | The connect flow + the neutral notification endpoint, on any adapter |
| `handleNotification(drives, input, options)` | Verifies an inbound notification and resolves it to the connections it concerns |
| `verifyHmacSignature(input)` | Constant-time HMAC over a **raw** body |
| `contentVersion(item)` | The content identity used for dedup |
| `withRetry(fn, policy?)` | Backoff honouring `Retry-After` |
| `createDriveFetch(options)` | The guarded, SSRF-validated, capped HTTP client |

### Storage strategies

| | `copy` | `reference` |
|---|---|---|
| Bytes | downloaded into your storage | **nothing is downloaded** |
| Availability | survives deletion at the provider | disappears with the original |
| Retention | your policy | the provider's |
| Auditability | can prove what the document said | can prove only that it was seen |
| Cost | storage + egress | zero |

Both are first-class. Pick `reference` when you must not duplicate a client's
documents; the engine guarantees no byte is fetched.

### Hooks

`drive:connected` · `drive:disconnected` · `drive:credentials_refreshed` ·
`drive:credentials_invalid` · `drive:sync_started` · `drive:sync_completed` ·
`drive:sync_failed` · `drive:item_imported` · `drive:item_skipped`

No payload ever carries a token. Add `'drive:*'` to `auditPlugin({ hooks })` for
a trail.

`drive:disconnected` carries `revoked: boolean` **and** a `revocation` that says
why it is false, because the reasons need different responses:

| `revocation` | Meaning | What to do |
|---|---|---|
| `revoked` | the provider accepted it | nothing — the grant is gone |
| `skipped` | you passed `{ revoke: false }` | nothing |
| `unsupported` | the adapter has no revocation endpoint, and never will (Microsoft Graph) | tell the user to withdraw consent in their account portal |
| `failed` | we asked and the provider did not answer | **retry** — the grant may still be live |

Branching on the boolean alone cannot separate the last two, and they are the
two that matter.

### Limits worth knowing before you design around them

| | |
|---|---|
| **Upload size** | single-request only: **4 MB** on Microsoft, **5 MB** on Google, **150 MB** on Dropbox. Larger files are refused with `DRIVE_CONTENT_TOO_LARGE` — up front when `DriveUploadInput.size` is supplied, mid-stream otherwise. Resumable sessions are not implemented. |
| **Checksums** | comparable **within one provider**, and on Microsoft only within one account type (`quickXorHash` on Business/SharePoint vs `sha1`/`sha256` on personal). Google-native Docs have none at all. Compare `algorithm` before `value`; to compare across providers, hash the bytes you imported. |
| **Notification "verified"** | a real HMAC over the raw body on Dropbox; a secret *we* chose, echoed back, on Google and Microsoft — those two vendors sign nothing. What makes the weaker one safe is that no vendor sends the changed data, so a forgery costs a wasted sync and nothing else. |
| **First sync** | bounded by `maxItems`/`maxPages` per run. For an adapter whose feed starts at "now" (Google), the engine enumerates first and **resumes** across runs until the walk finishes, then switches to the feed. |

### Error codes

`DRIVE_PROVIDER_UNKNOWN` · `DRIVE_CONNECTION_NOT_FOUND` (404, also for another
tenant's connection) · `DRIVE_TENANT_REQUIRED` · `DRIVE_TENANT_MISMATCH` ·
`DRIVE_CREDENTIALS_INVALID` · `DRIVE_AUTHORIZATION_INVALID` ·
`DRIVE_RATE_LIMITED` · `DRIVE_HOST_NOT_ALLOWED` · `DRIVE_CONTENT_TOO_LARGE` ·
`DRIVE_ACCESS_DENIED` (403 — the grant is fine, this operation is not
permitted; re-consenting would not help) · `DRIVE_ITEM_NOT_FOUND` ·
`DRIVE_PROVIDER_ERROR` (the only `DRIVE_` code whose retryability the adapter
decides: a 5xx is retried, a 4xx is not) · `DRIVE_CURSOR_RESET` (the change
cursor aged out; the engine drops it and the next run re-primes) ·
`DRIVE_UNSUPPORTED` ·
`DRIVE_NOTIFICATION_INVALID` · `DRIVE_SECRET_MALFORMED` ·
`DRIVE_SECRET_KEY_UNKNOWN` · `DRIVE_SECRET_KEY_INVALID`

## Writing a provider adapter

An adapter is translation, not logic. Only `name`, `allowedHosts`,
`authorization`, `list` and `download` are required.
`@basaltkit/drives-dropbox` is the reference implementation.

Four optional members exist because the vendors genuinely differ, and declaring
them is how an adapter tells the engine which vendor it is:

| Member | Declare it when |
|---|---|
| `deltaIncludesExisting` | the cursor from `startDelta` replays what already exists (Dropbox, Graph). Default `false` makes the engine run a listing pass first, so an adapter that forgets costs extra reads instead of losing a tenant's files (Google's `getStartPageToken` really is "from now"). |
| `retryAfterFromBody` | the vendor puts its rate-limit hint somewhere other than `Retry-After` (Dropbox). |
| `DriveNotificationResult.accountIds` | notifications identify a connection by account rather than by a secret you chose (Dropbox). |
| `DriveChange` removal `path` | deletions are reported by path because the vendor gives no id for them (Dropbox). |

Throw `DriveCursorResetError` when the vendor invalidates a stored cursor —
Dropbox's `409 reset/`, Graph's `410 resyncRequired`, an aged-out Google
`pageToken`. Mapped to anything else, the dead cursor is persisted and every
future sync fails the same way for ever.

```ts
export const myDrive = (keys: Keys): DriveProvider => ({
  name: 'mydrive',
  // The primary SSRF control. Provider responses carry URLs we then fetch,
  // so they are attacker-influenced data, not trusted configuration.
  allowedHosts: ['api.mydrive.com', '.files.mydrive.com'],
  authorization: {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) => `https://…`,
    exchange: async ({ code, redirectUri, codeVerifier, fetch }) => {
      const res = await fetch('https://api.mydrive.com/oauth/token', { method: 'POST', body: /* … */ })
      const json = await res.json<TokenResponse>()
      return { accessToken: json.access_token, refreshToken: json.refresh_token,
               expiresAt: Date.now() + json.expires_in * 1000 }
    },
    refresh: async ({ refreshToken, fetch }) => { /* throw DriveCredentialsInvalidError on invalid_grant */ },
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

- **You never see the refresh token.** `session` carries one short-lived access
  token. A bug in an adapter cannot exfiltrate the long-lived credential.
- **You never call `fetch` yourself.** `session.fetch` is host-allowlisted,
  SSRF-validated, IP-pinned, byte-capped and timed out.

Test it against the same suite the built-in fake passes:

```ts
import { FakeDriveProvider } from '@basaltkit/drives/testing'
```

`FakeDriveProvider` can provoke every behaviour the engine claims to handle —
expiring tokens, rotating refresh tokens, revoked grants, rate limits,
pagination, delta feeds, deletions, mid-stream download failures and
notifications with the wrong secret.

## Security

Read the analysis in [RFC 0002 §5](../../docs/rfcs/0002-basaltkit-drives.md).
In short: `https:` only by default; a per-provider host allowlist checked before
DNS and after every redirect; private/loopback/link-local/metadata addresses
refused with the socket pinned against DNS rebinding; manual redirects
re-validated per hop; byte caps enforced mid-stream; no transparent
decompression; whole-exchange timeouts; constant-time notification-secret
comparison; and no token in any log, error, hook payload or audit entry.

A provider **download URL is itself a bearer credential** — Graph's
`@microsoft.graph.downloadUrl`, Google's signed `googleusercontent.com`
redirect target. It is kept out of listings (`$select`ed away), out of
`DriveItem.raw`, out of sinks and the ledger, and out of every error: a refusal
from the guarded fetch names the **host and a fixed reason, never the URL**,
which is why `DRIVE_HOST_NOT_ALLOWED` is raised here instead of letting
`@basaltkit/webhooks`' guard — which quotes the URL it refused — escape.

## License

MIT
