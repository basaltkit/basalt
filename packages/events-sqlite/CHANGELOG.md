# @basaltkit/events-sqlite

## 1.0.5

### Initial release

- Durable, SQLite-backed `OutboxStore` for `@basaltkit/events`, on Node's built-in
  `node:sqlite` — the single-node counterpart to the in-memory
  `MemoryOutboxStore`. Un-relayed transactional-outbox entries now survive a
  crash/restart instead of being lost.
- `sqliteOutboxStore(path)` returns a store ready for `outboxPlugin({ store })`,
  with `enqueue`/`pending`/`markPublished`/`markFailed`/`all`. A partial index on
  un-published rows keeps the relay scan cheap.
