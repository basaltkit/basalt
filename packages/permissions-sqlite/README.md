<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/permissions-sqlite

Durable, **SQLite-backed** implementation of the [`@basaltkit/permissions`](https://github.com/basaltkit/basalt/tree/main/packages/permissions)
`AccessStore` — role assignments and permission grants — plus durable
`TemporaryGrantStore` and `DelegationStore`, built on Node's
built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

`@basaltkit/permissions` requires an `AccessStore` and ships an in-memory one that
forgets everything on restart. Swap in this and role assignments and grants
persist — no ORM, no migration tool, no service. It's the single-node reference
backend; the production (Postgres/MySQL) counterpart is
[`@basaltkit/permissions-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/permissions-prisma).

```bash
pnpm add @basaltkit/permissions-sqlite   # peer: @basaltkit/permissions
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

```ts
import { permissionsPlugin } from '@basaltkit/permissions'
import { sqliteAccessStore } from '@basaltkit/permissions-sqlite'

const p = sqliteAccessStore('./data/permissions.db')   // ':memory:' by default

const app = await createApp({
  plugins: [
    permissionsPlugin({
      store: p.store,
      // Optional — time-boxed grants and delegations that survive a restart:
      temporaryGrants: p.temporaryGrants,
      delegations: p.delegations,
    }),
  ],
}).boot()
```

The store implements the exact `AccessStore` contract, so the rest of your
permissions code is untouched. `SqliteAccessStore` is also exported and takes a
`DatabaseSync`, so it can share a handle with the other `*-sqlite` stores.

## Data model

Three grant tables, each a composite-key set — every write is `INSERT OR IGNORE`, so
re-assigning a role or re-granting a permission is a harmless no-op:

| Table | Holds |
| --- | --- |
| `perm_user_roles` | `(scope, user_id, role)` |
| `perm_user_permissions` | `(scope, user_id, permission)` — direct user grants |
| `perm_role_permissions` | `(scope, role, permission)` |

Everything is scoped, so `t1` and `t2` never see each other's grants. A
multi-permission grant (`grantToRole`, `grantToUser`) is written in one
savepoint: all of it, or — when any row fails — none of it.

Two more tables back `temporaryGrants` and `delegations` (`migrate()` creates
them with `IF NOT EXISTS`, so an existing database gains them on its next open):

| Table | Holds |
| --- | --- |
| `perm_temporary_grants` | `id` (PK), `scope`, `user_id`, `permissions` (JSON array), `expires_at` (epoch ms), `granted_by`, `reason` |
| `perm_delegations` | `id` (PK), `scope`, `from_user_id`, `to_user_id`, `permissions` (JSON array), `created_at`, `expires_at` (epoch ms, `NULL` = open-ended) |

Reads filter `expires_at > now`, user and scope in SQL — the Gate re-checks every
row anyway. A repeated id replaces the row. Expired rows are inert until
`pruneExpired(now?)` deletes them.

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `sqliteAccessStore(dbOrLocation?)` | function | Opens (or reuses) a database, applies the schema, returns `{ db, store, temporaryGrants, delegations }`. Defaults to `':memory:'`. |
| `SqliteAccessStore` | class | The `AccessStore` implementation. `new SqliteAccessStore(db)` — pass a `DatabaseSync` to share one handle with the other `*-sqlite` stores. |
| `SqliteTemporaryGrantStore` | class | Durable `TemporaryGrantStore`. `new SqliteTemporaryGrantStore(db)`; adds `pruneExpired(now?)` → rows deleted. |
| `SqliteDelegationStore` | class | Durable `DelegationStore`. `new SqliteDelegationStore(db)`; `pruneExpired(now?)` deletes delegations past their deadline (open-ended ones stay). |
| `openPermissionsDatabase(location?)` | function | Opens a `DatabaseSync` and migrates it. Defaults to `':memory:'`. |
| `migrate(db)` | function | Applies the idempotent schema to an existing handle. Safe on every boot. |
| `SqlitePermissionsStores` | interface | `{ db, store, temporaryGrants, delegations }`. |

`sqliteAccessStore` accepts a single argument — a path or an existing
`DatabaseSync` — and has no options object. `migrate()` sets
`journal_mode = WAL` and `busy_timeout = 5000`, so a competing writer waits up
to 5 s for the lock instead of throwing "database is locked" immediately.

## Errors

This package defines no `BasaltError` subclasses and no error codes. `node:sqlite`
throws its own errors (locked database, disk I/O) unchanged. The authorization
errors a client sees — `PERMISSION_DENIED`, `AUTH_REQUIRED`,
`PERMISSION_META_INVALID` — come from `@basaltkit/permissions`.

Direct writes (`assignRole`, `removeRole`, `grantToRole`, `grantToUser`) throw a
`TypeError` for an empty or non-string user id, role name or scope, and for a
permission list that is not an array of non-empty strings — nothing is written.
`''`, `null` and `undefined` would otherwise share one "nobody" row whose grants
apply to every caller with a missing id. Seed scripts that write through the
store directly get the same guarantee as writes through the `Gate`. `add()` on the
temporary-grant and delegation stores refuses the same malformed ids, a
non-string `grantedBy`/`reason`, and an `expiresAt`/`createdAt` that is not a
finite number.

The one failure worth naming: on Node 22.x, importing this package without
`--experimental-sqlite` fails at load with an unknown-builtin error for
`node:sqlite`. Node 24 needs no flag.

## Hooks & events

None.

Guides: [Authorization](/guide/authorization) · [Persistence](/guide/persistence).

## License

MIT
