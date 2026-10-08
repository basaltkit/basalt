---
"@basaltkit/drives": minor
---

Connection health: `DriveConnection` / `DriveConnectionView` gain optional `lastSucceededAt`, `lastFailedAt` and `lastErrorCode` (an error code, never a message). They are stamped by a sync that persisted a page, by a failed sync (a best-effort compare-and-set against the run's own revision, skipped for an abort), by the refresh that marks a grant invalid (inside the same compare-and-set write), and by the new `drives.check(connectionId, { tenantId })` probe, which lists one item at the root and returns `{ ok, code? }`. No write is added to ordinary successful calls. Durable stores should persist the three new nullable columns.
