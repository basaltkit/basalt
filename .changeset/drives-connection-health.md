---
"@basaltkit/drives": minor
---

Connection health: `DriveConnection` / `DriveConnectionView` gain optional `lastSucceededAt`, `lastFailedAt` and `lastErrorCode` (an error code, never a message). They are stamped by a sync that persisted a page, by a failed sync (a best-effort compare-and-set against the run's own revision, skipped for an abort), by the refresh that marks a grant invalid (inside the same compare-and-set write), and by the new `drives.check(connectionId, { tenantId })` probe, which lists one item at the root and returns `{ ok, code? }`. No write is added to ordinary successful calls.

Opt-in per store: `DriveConnectionStore` gains an optional `persistsHealth` flag, and the engine puts the three keys in an `update()` patch only when it is `true` (`MemoryDriveConnectionStore` sets it). An existing durable store keeps working unchanged after the upgrade: it never receives the new keys, its connections report no health, and `check()` still returns its answer without writing. To enable health on a durable store, add the three nullable columns and migrate first, then set `persistsHealth = true` — a store that spreads the patch onto Prisma would otherwise fail with `Unknown argument`. The contract suite (`runDriveStoreContract`) checks the round-trip only for a store that declares the flag.
