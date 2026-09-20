---
'@basaltkit/drives': minor
---

New package: `@basaltkit/drives` — connect a tenant's external file-storage
accounts (Google Drive, OneDrive/SharePoint, Dropbox) and import documents from
them.

This is phase 1 of RFC 0002: the provider-neutral contract plus everything
generic above it. Vendor adapters ship as satellites (`drives-google`,
`drives-microsoft`, `drives-dropbox`) in a later phase.

- **Connections** — many per tenant per provider ("Drive Finance", "Drive HR"),
  each with its own label, root, credentials and sync cursor.
- **Credentials** — AES-256-GCM at rest, bound by AAD to
  `(tenant, connection, provider)` so a ciphertext cannot be moved between rows;
  a key ring makes rotation a rolling change; refresh is proactive and
  single-flight, rotation is persisted, and a lost rotation race no longer
  condemns a healthy connection.
- **Listing and download** — provider-agnostic cursor pagination; downloads
  stream into `@basaltkit/files` via `putStream` and are never buffered.
- **Sync** — incremental on the provider's delta token or cursor, with a full
  listing fallback; discovers and enqueues, never downloads, so an HTTP request
  cannot block on a drive of any size.
- **Dedup** — keyed by `(tenant, connection, externalId)` and checked before the
  download, so an unchanged file costs a local read rather than its size in
  egress.
- **Security** — `https:` by default, per-provider host allowlist re-checked
  after every redirect, SSRF validation with IP pinning (reusing
  `@basaltkit/webhooks`' guard), mid-stream byte caps, no transparent
  decompression, whole-exchange timeouts, constant-time notification-secret
  comparison, and no token in any log, error, hook payload or audit entry.
- **Testing** — `@basaltkit/drives/testing` ships `FakeDriveProvider`, which can
  provoke every behaviour the engine handles without touching the network.

Adapter-agnostic: the package registers no routes yet, and the notification
helpers work on any `@basaltkit/http` adapter.
