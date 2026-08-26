<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/teams-sqlite

Durable, **SQLite-backed** implementations of the [`@basaltkit/teams`](https://github.com/basaltkit/basalt/tree/main/packages/teams)
stores — **memberships** and **invitations** — built on Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html). **Zero external
dependencies.**

`@basaltkit/teams` ships in-memory stores that forget everything on restart. Swap
in these and team rosters and pending invitations survive a redeploy — no ORM,
no migration tool, no service to run. It's the single-node reference backend for
teams; the production (Postgres/MySQL) counterpart is
[`@basaltkit/teams-prisma`](https://github.com/basaltkit/basalt/tree/main/packages/teams-prisma).

```bash
pnpm add @basaltkit/teams-sqlite   # peer: @basaltkit/teams
```

> Requires **Node 22.5+**. Stable and flag-free on Node 24; on 22.x run with
> `--experimental-sqlite`.

## Use it

`sqliteTeamsStores()` opens (or creates) the database, applies the schema, and
returns both stores named to drop straight into `teamsPlugin`:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'

const t = sqliteTeamsStores('./data/teams.db')   // ':memory:' by default

const app = await createApp({
  plugins: [
    teamsPlugin({ memberships: t.memberships, invitations: t.invitations }),
  ],
}).boot()
```

That's the whole change — the rest of your teams code is untouched, because
these classes implement the exact same store contracts as the in-memory ones.

## Pick individual stores

Both stores are exported and take a `DatabaseSync`, so you can share one handle
with the rest of your app (or with `@basaltkit/auth-sqlite`):

```ts
import { openTeamsDatabase, SqliteMembershipStore, SqliteInvitationStore } from '@basaltkit/teams-sqlite'

const db = openTeamsDatabase('./data/app.db')
const memberships = new SqliteMembershipStore(db)
const invitations = new SqliteInvitationStore(db)
```

| Export | Contract | Table |
| --- | --- | --- |
| `SqliteMembershipStore` | `MembershipStore` | `team_memberships` |
| `SqliteInvitationStore` | `InvitationStore` | `team_invitations` |

## Notes

- **Schema** is created with `CREATE TABLE IF NOT EXISTS`, so `migrate()` is safe
  on every boot. WAL journaling is on.
- **`add()` upserts** a membership (matches the in-memory `Map.set` semantics).
- **Pending** invitations are those with no `accepted_at` and no `revoked_at`;
  expiry is the caller's concern, exactly as in the in-memory store.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contracts.

## License

MIT
