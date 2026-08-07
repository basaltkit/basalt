# @machize/auth-sqlite

Durable, **SQLite-backed** implementations of every [`@machize/auth`](https://github.com/Zebedeu/machize/tree/main/packages/auth)
store — users, sessions, refresh tokens, one-time tokens, API keys and MFA
state — built on Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html).
**Zero external dependencies.**

`@machize/auth` ships in-memory stores that are perfect for dev and tests but
lose everything on restart. Swap in these and your users stay logged in, your
API keys keep working, and password-reset tokens survive a redeploy — no ORM, no
migration tool, no service to run. It's the reference "real backend" for auth
and the pattern other durable stores follow.

```bash
pnpm add @machize/auth-sqlite   # peer: @machize/auth
```

> Requires **Node 22.5+**. On Node 24 `node:sqlite` is stable and needs no flag;
> on 22.x run with `--experimental-sqlite`.

## Use it

`sqliteAuthStores()` opens (or creates) the database, applies the schema, and
returns every store named to drop straight into the auth plugins:

```ts
import { authPlugin, apiKeysPlugin } from '@machize/auth'
import { sqliteAuthStores } from '@machize/auth-sqlite'

const s = sqliteAuthStores('./data/auth.db')   // ':memory:' by default

const app = await createApp({
  plugins: [
    authPlugin({
      secret: process.env.AUTH_SECRET!,
      users: s.users,
      sessions: s.sessions,
      refreshTokens: s.refreshTokens,
      tokens: s.tokens,   // email verification + password reset
      mfa: s.mfa,
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
  ],
}).boot()
```

That's the whole change — the rest of your auth code is untouched, because these
classes implement the exact same store contracts as the in-memory ones.

## Pick individual stores

Every store is exported on its own and takes a `DatabaseSync`, so you can mix
backends — e.g. keep sessions in Redis but users in SQLite:

```ts
import { openAuthDatabase, SqliteUserSource, SqliteSessionStore } from '@machize/auth-sqlite'

const db = openAuthDatabase('./data/auth.db')
const users = new SqliteUserSource(db)
const sessions = new SqliteSessionStore(db)
```

| Export | Contract | Table |
| --- | --- | --- |
| `SqliteUserSource` | `UserSource` | `auth_users` |
| `SqliteSessionStore` | `SessionStore` | `auth_sessions` |
| `SqliteRefreshTokenStore` | `RefreshTokenStore` | `auth_refresh_tokens` |
| `SqliteAuthTokenStore` | `AuthTokenStore` | `auth_tokens` |
| `SqliteApiKeyStore` | `ApiKeyStore` | `auth_api_keys` |
| `SqliteMfaStore` | `MfaStore` | `auth_mfa` |

## Bring your own database handle

`sqliteAuthStores()` also accepts a `DatabaseSync` you already opened (it runs
the idempotent migration on it), so auth can share one connection with the rest
of your app:

```ts
import { DatabaseSync } from 'node:sqlite'
import { sqliteAuthStores } from '@machize/auth-sqlite'

const db = new DatabaseSync('./data/app.db')
const s = sqliteAuthStores(db)   // creates the auth_* tables if missing
```

`openAuthDatabase(location)` and `migrate(db)` are exported if you'd rather wire
things up yourself.

## Notes

- **Schema** is created with `CREATE TABLE IF NOT EXISTS`, so `migrate()` is safe
  to run on every boot. WAL journaling is enabled for concurrent reads.
- **Secrets are never stored in the clear** — the same as the in-memory stores.
  API keys persist only their SHA-256 `hash` and a display `prefix`; MFA recovery
  codes are stored hashed by `@machize/auth` before they reach the store.
- **Expired sessions** are evicted lazily on lookup, matching the in-memory
  store's behavior.
- `node:sqlite` is synchronous; the methods stay `async` to honor the contracts,
  so there's no behavioral difference for callers.

## When to reach for something else

SQLite is an excellent default for single-node deployments and is genuinely
production-grade. If you run multiple instances that must share auth state, point
sessions/refresh tokens at Redis (`@machize/auth`'s Redis stores) and keep users
in your primary database. These SQLite stores are the reference implementation of
the durable-store pattern — copy them for Postgres/MySQL when you need it.

## License

MIT
