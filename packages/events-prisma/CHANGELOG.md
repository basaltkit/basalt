# @basaltkit/events-prisma

## 1.0.5

### Initial release

- Prisma-backed `OutboxStore` for `@basaltkit/events` — the production
  (PostgreSQL/MySQL) counterpart to the in-memory `MemoryOutboxStore`. Bring your
  own `PrismaClient`; ships a reference `schema.prisma` (`OutboxEntry`),
  discoverable by `basalt prisma:sync`.
- `prismaOutboxStore(client)` returns a store ready for `outboxPlugin({ store })`,
  with `enqueue`/`pending`/`markPublished`/`markFailed`/`all`. Keeping the outbox
  in your primary database lets you enqueue events in the same transaction as the
  state change — at-least-once, crash-safe delivery. Fails fast when the client
  lacks the `OutboxEntry` model.
