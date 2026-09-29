---
'@basaltkit/permissions-prisma': minor
'@basaltkit/permissions-sqlite': minor
---

Durable `TemporaryGrantStore` and `DelegationStore` (FRAMEWORK-AUDIT FA-H07). Only the in-memory stores existed, so time-boxed grants and delegations vanished on restart and were invisible to other instances.

- `@basaltkit/permissions-prisma`: `PrismaTemporaryGrantStore` and `PrismaDelegationStore` on two new models, `PermTemporaryGrant` (`perm_temporary_grants`) and `PermDelegation` (`perm_delegations`), in the reference `schema.prisma` (`permissions String[]`) and `schema.mysql.prisma` (`permissions Json`, `reason` TEXT, `columnLimits: 'mysql'` preset extended). `prismaAccessStore()` now also returns `temporaryGrants` and `delegations`. The models are optional on `PrismaPermissionsClient` and checked on first use, so an app that does not wire the new stores needs no migration; one that does adds the two models (`basalt prisma:sync`) and migrates.
- `@basaltkit/permissions-sqlite`: `SqliteTemporaryGrantStore` and `SqliteDelegationStore`; `migrate()` creates `perm_temporary_grants` and `perm_delegations` (`CREATE TABLE IF NOT EXISTS`, so existing databases gain them on the next open). `sqliteAccessStore()` now also returns `temporaryGrants` and `delegations`.

Both filter `expires_at > now`, user and scope in the query (the Gate re-verifies each row regardless), validate what they persist (`TypeError` on an empty id/user/scope, a non-string permission, a non-finite or out-of-range deadline), replace on a repeated id like the in-memory stores, and add `pruneExpired(now?)` to delete inert rows. Wire them with:

```ts
const p = prismaAccessStore(prisma) // or sqliteAccessStore('./data/permissions.db')
permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
```
