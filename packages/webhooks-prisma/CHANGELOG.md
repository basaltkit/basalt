# @basaltkit/webhooks-prisma

## 1.1.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.

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
