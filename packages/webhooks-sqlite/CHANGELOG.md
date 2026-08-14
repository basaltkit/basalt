# @basaltkit/webhooks-sqlite

## 1.1.0

### Minor Changes

- Security: `SqliteWebhookStore.remove(id, tenantId?)` now scopes the delete by `tenant_id` when a tenant is given, so one tenant can't delete another's endpoint by id (see `@basaltkit/webhooks` 1.1.0).

## 1.0.5

### Initial release

- Durable, SQLite-backed `WebhookStore` for `@basaltkit/webhooks`, on Node's
  built-in `node:sqlite` — the single-node counterpart to the in-memory
  `MemoryWebhookStore`. Registered outbound endpoints now survive a restart
  instead of vanishing on redeploy.
- `sqliteWebhookStore(path)` returns a store ready for `webhooksPlugin({ store })`,
  with `add`/`forEvent`/`list`/`remove`. Event-pattern matching reuses
  `matchesEvent`, so behaviour is identical to the memory store.
