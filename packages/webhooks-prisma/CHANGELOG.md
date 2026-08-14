# @basaltkit/webhooks-prisma

## 1.1.0

### Minor Changes

- Security: `PrismaWebhookStore.remove(id, tenantId?)` now scopes the delete by `tenantId` when a tenant is given, so one tenant can't delete another's endpoint by id (see `@basaltkit/webhooks` 1.1.0).

## 1.0.5

### Initial release

- Prisma-backed `WebhookStore` for `@basaltkit/webhooks` — the production
  (PostgreSQL/MySQL) counterpart to the in-memory `MemoryWebhookStore`. Bring
  your own `PrismaClient`; ships a reference `schema.prisma` (`WebhookEndpoint`),
  discoverable by `basalt prisma:sync`.
- `prismaWebhookStore(client)` returns a store ready for `webhooksPlugin({ store })`,
  with `add`/`forEvent`/`list`/`remove`. Registered outbound endpoints survive a
  restart and can be shared across instances. Fails fast when the client lacks the
  `WebhookEndpoint` model.
