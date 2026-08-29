<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/permissions-sqlite

Durable, **SQLite-backed** implementation of the [`@basaltkit/permissions`](https://github.com/basaltkit/basalt/tree/main/packages/permissions)
`AccessStore` — role assignments and permission grants — built on Node's
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
  plugins: [permissionsPlugin({ store: p.store })],
}).boot()
```

The store implements the exact `AccessStore` contract, so the rest of your
permissions code is untouched. `SqliteAccessStore` is also exported and takes a
`DatabaseSync`, so it can share a handle with the other `*-sqlite` stores.

## Data model

Three tables, each a composite-key set — every write is `INSERT OR IGNORE`, so
re-assigning a role or re-granting a permission is a harmless no-op:

| Table | Holds |
| --- | --- |
| `perm_user_roles` | `(scope, user_id, role)` |
| `perm_user_permissions` | `(scope, user_id, permission)` — direct user grants |
| `perm_role_permissions` | `(scope, role, permission)` |

Everything is scoped, so `t1` and `t2` never see each other's grants.

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `sqliteAccessStore(dbOrLocation?)` | function | Opens (or reuses) a database, applies the schema, returns `{ db, store }`. Defaults to `':memory:'`. |
| `SqliteAccessStore` | class | The `AccessStore` implementation. `new SqliteAccessStore(db)` — pass a `DatabaseSync` to share one handle with the other `*-sqlite` stores. |
| `openPermissionsDatabase(location?)` | function | Opens a `DatabaseSync` and migrates it. Defaults to `':memory:'`. |
| `migrate(db)` | function | Applies the idempotent schema to an existing handle. Safe on every boot. |
| `SqlitePermissionsStores` | interface | `{ db, store }`. |

`sqliteAccessStore` accepts a single argument — a path or an existing
`DatabaseSync` — and has no options object. `migrate()` sets
`journal_mode = WAL` and `busy_timeout = 5000`, so a competing writer waits up
to 5 s for the lock instead of throwing "database is locked" immediately.

## Errors

This package defines no `BasaltError` subclasses and no error codes. `node:sqlite`
throws its own errors (locked database, disk I/O) unchanged. The authorization
errors a client sees — `PERMISSION_DENIED`, `AUTH_REQUIRED`,
`PERMISSION_META_INVALID` — come from `@basaltkit/permissions`.

The one failure worth naming: on Node 22.x, importing this package without
`--experimental-sqlite` fails at load with an unknown-builtin error for
`node:sqlite`. Node 24 needs no flag.

## Hooks & events

None.

Guides: [Authorization](/guide/authorization) · [Persistence](/guide/persistence).

## License

MIT
