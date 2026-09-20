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

## Connecting an account

Two steps, with one value carried between them in a cookie.

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
  onRemoved: ({ externalId, targetId }) => archiveDocument(targetId),
})
// → { seen, enqueued, skipped, removed, truncated, mode: 'delta' | 'listing' }
```

`maxItems` (default 1000) and `maxPages` (default 50) are **hard ceilings**, not
hints. The first sync of a mature Google Drive can be hundreds of thousands of
items; the cursor is persisted after every page, so a truncated run resumes
exactly where it stopped.

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
job. Any other error is treated as transient.

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

```ts
const watch = await watchConnection(drives, connection.id, {
  notificationUrl: 'https://app.example.com/drives/google/notify',
})

// In the route — keep the RAW body, signature schemes sign bytes, not objects.
const outcome = await handleNotification(drives, { method, headers, query, body: rawBuffer }, {
  provider: 'google',
  connections: await connectionsForThisRoute(),
  replayGuard,
})

if (outcome.challenge) return reply.type('text/plain').send(outcome.challenge)
if (outcome.shouldSync) await SyncDrive.dispatch({ connectionId: outcome.connection!.id })
```

::: warning This endpoint is unauthenticated by construction
The provider calls it, so there is no session. The design bounds that rather
than pretending otherwise: **no provider sends the changed data**, so even a
perfectly forged notification can only cause your app to go and ask the
provider, with its own credentials, for its own tenant. The blast radius of a
spoof is a wasted sync.

The `connections` candidate list is supplied by **you** and never scanned across
tenants, so an unauthenticated caller cannot address another tenant's connection
at all.
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
  entry.

See [Security](/guide/security) and
[RFC 0002](https://github.com/basaltkit/basalt/blob/main/docs/rfcs/0002-basaltkit-drives.md).

## What this package does not do

It brings bytes across safely and records provenance. It has no opinion about
what a document **means**. Quarantine policy, OCR, extraction, classification,
approval workflow, retention, and which folder maps to which matter or client
are all yours. The seam is `DriveSink`.

Deletion at the provider is **reported, never acted on** — whether it should
delete your copy is a retention decision, and retention is a legal question.
