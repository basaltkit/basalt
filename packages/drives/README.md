# @basaltkit/drives

Connect a tenant's **external file-storage accounts** — Google Drive,
OneDrive/SharePoint, Dropbox — to a Basalt app, and import documents from them.

The provider-specific part is small and lives in an adapter. Everything else is
here: many connections per tenant, OAuth credentials encrypted at rest with
refresh and rotation, provider-agnostic pagination, streaming download that
never buffers, incremental sync on a cursor, dedup, rate-limit backoff, and
inbound notification verification.

> **Status: `0.1.0`, unpublished.** The contract is implemented and tested
> against a full in-memory provider; the vendor adapters land next. See
> [RFC 0002](../../docs/rfcs/0002-basaltkit-drives.md).

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
import { googleDrive } from '@basaltkit/drives-google' // phase 2

const app = createApp({
  plugins: [
    tenancyPlugin({ /* … */ }),
    filesPlugin({ disk: 'documents', validate: { sniff: true } }),
    drivesPlugin({
      providers: [googleDrive({ clientId: env.GOOGLE_ID, clientSecret: env.GOOGLE_SECRET })],
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

```ts
const drives = app.container.get(DRIVES)

// 1. Send the browser to the provider. Put `binding` in an HttpOnly,
//    SameSite=Lax, Secure cookie — it is what ties the flow to this browser.
const { url, binding } = drives.startAuthorization({
  provider: 'google',
  redirectUri: 'https://app.example.com/drives/google/callback',
})

// 2. At the callback, hand the cookie back.
const connection = await drives.completeAuthorization({
  provider: 'google',
  code, state,
  binding: request.cookies['drive_binding'],
  redirectUri: 'https://app.example.com/drives/google/callback',
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
| `handleNotification(drives, input, options)` | Verifies an inbound notification and resolves it to a connection |
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

### Error codes

`DRIVE_PROVIDER_UNKNOWN` · `DRIVE_CONNECTION_NOT_FOUND` (404, also for another
tenant's connection) · `DRIVE_TENANT_REQUIRED` · `DRIVE_TENANT_MISMATCH` ·
`DRIVE_CREDENTIALS_INVALID` · `DRIVE_AUTHORIZATION_INVALID` ·
`DRIVE_RATE_LIMITED` · `DRIVE_HOST_NOT_ALLOWED` · `DRIVE_CONTENT_TOO_LARGE` ·
`DRIVE_UNSUPPORTED` · `DRIVE_NOTIFICATION_INVALID` · `DRIVE_SECRET_MALFORMED` ·
`DRIVE_SECRET_KEY_UNKNOWN` · `DRIVE_SECRET_KEY_INVALID`

## Writing a provider adapter

An adapter is translation, not logic. Only `name`, `allowedHosts`,
`authorization`, `list` and `download` are required.

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

## License

MIT
