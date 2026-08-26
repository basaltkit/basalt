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

## License

MIT
