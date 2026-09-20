<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/auth-prisma

**Prisma-backed** implementations of every [`@basaltkit/auth`](https://github.com/basaltkit/basalt/tree/main/packages/auth)
store — users, sessions, refresh tokens, one-time tokens, API keys and MFA
state — for production databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` whose schema includes the `Auth*` models;
the stores only touch those delegates, so they layer onto your existing client
without owning your schema or connection. It's the production counterpart to
[`@basaltkit/auth-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/auth-sqlite)
(the zero-dependency, single-node option) — same store contracts, different
backend.

```bash
pnpm add @basaltkit/auth-prisma   # peer: @basaltkit/auth ; you already have @prisma/client
```

## 1. Add the models

Copy the models from the bundled reference schema into your `schema.prisma`
(also available at `@basaltkit/auth-prisma/schema.prisma`):

```prisma
model AuthUser {
  id            String  @id
  email         String  @unique
  passwordHash  String
  emailVerified Boolean @default(false)
  @@map("auth_users")
}
model AuthSession        { id String @id  userId String  expiresAt DateTime  @@index([userId]) @@map("auth_sessions") }
model AuthRefreshToken   { token String @id  familyId String  userId String  expiresAt DateTime  usedAt DateTime?  @@index([familyId]) @@index([userId]) @@map("auth_refresh_tokens") }
model AuthToken          { token String @id  userId String  purpose String  expiresAt DateTime  usedAt DateTime?  @@index([userId, purpose]) @@map("auth_tokens") }
model AuthApiKey         { id String @id  name String  prefix String  hash String @unique  tenantId String?  userId String?  scopes String[]  createdAt DateTime  expiresAt DateTime?  lastUsedAt DateTime?  revokedAt DateTime?  @@map("auth_api_keys") }
model AuthMfa            { userId String @id  secret String  enabled Boolean @default(false)  recoveryCodes String[]  lastUsedStep Int?  @@map("auth_mfa") }
```

Then `prisma migrate dev` (or `prisma db push`) and `prisma generate`.

> `scopes` and `recoveryCodes` use PostgreSQL scalar lists (`String[]`). On a
> database without scalar-list support (e.g. SQLite), model them as `Json` and
> adapt — or just use `@basaltkit/auth-sqlite`.

## Upgrading to 1.5

1.5.0 added optional API key expiration, stored in a new nullable column:
`AuthApiKey.expiresAt` (`auth_api_keys.expiresAt`). Copying the model and
running `prisma generate` is **not enough** — the database needs the column too,
or every API-key request fails. Create a migration:

```bash
prisma migrate dev --name add_api_key_expires_at
```

On PostgreSQL the generated migration is:

```sql
ALTER TABLE "auth_api_keys" ADD COLUMN "expiresAt" TIMESTAMP(3);
```

**Schema-per-tenant:** `auth_api_keys` lives in each tenant schema, so the column
must be added in **every** tenant schema. Add the migration to your tenant
migrations, then run `basalt tenant:migrate`. A test suite that never issues an
API key will stay green while production fails, so check this explicitly.

Until the column exists, `PrismaApiKeyStore` throws `ApiKeySchemaOutdatedError`
(code `AUTH_API_KEY_SCHEMA_OUTDATED`) with these instructions, keeping the
original Prisma error (`P2022`) as `cause`.

## 2. Wire the stores

`prismaAuthStores(prisma)` returns every store named to drop straight into the
auth plugins — pass your client directly, no cast:

```ts
import { authPlugin, apiKeysPlugin } from '@basaltkit/auth'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const s = prismaAuthStores(prisma)

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

Every store is also exported on its own (`PrismaUserSource`, `PrismaSessionStore`,
…) and takes the client in its constructor, so you can mix backends.

| Export | Contract | Model |
| --- | --- | --- |
| `PrismaUserSource` | `UserSource` | `AuthUser` |
| `PrismaSessionStore` | `SessionStore` | `AuthSession` |
| `PrismaRefreshTokenStore` | `RefreshTokenStore` | `AuthRefreshToken` |
| `PrismaAuthTokenStore` | `AuthTokenStore` | `AuthToken` |
| `PrismaApiKeyStore` | `ApiKeyStore` | `AuthApiKey` |
| `PrismaMfaStore` | `MfaStore` | `AuthMfa` |

### Bulk contact lookup (`findByIds`)

`PrismaUserSource.findByIds(ids)` resolves a set of accounts in one
`WHERE id IN (…)` instead of one query per id — the fast path behind
`@basaltkit/teams`' `roleRecipients` ("email every admin of this tenant").

- It `select`s only `id`, `email` and `emailVerified`, so the password hash is
  never read, let alone returned.
- The id list is **chunked** (500 per query by default, far below PostgreSQL's
  65 535 bind parameters), so a ten-thousand-member tenant can't blow the
  driver's parameter limit. Tune it with
  `new PrismaUserSource(prisma, { idChunkSize: 1000 })`.
- The result keeps the order of `ids`; ids with no row are omitted.

## Multi-tenant?

Pair with [`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma):
resolve the per-tenant client from the request context and build the stores over
it, so each tenant's auth data lives in its own database/schema.

## Notes

- **Time** is stored as `DateTime`; the `@basaltkit/auth` contracts model it as
  epoch-ms `number`, and the stores convert at the boundary.
- **Secrets are never stored in the clear** — API keys persist only their
  SHA-256 `hash` and a display `prefix`; MFA recovery codes arrive already
  hashed from `@basaltkit/auth`.
- **Expired sessions** are evicted lazily on lookup, matching the other stores.
- `markUsed` uses `updateMany`, so it's a tolerant no-op if the token is gone —
  the same semantics as the in-memory and SQLite stores.

## Typing note

`PrismaAuthClient` types delegate **arguments** as `any` (returns stay precise):
Prisma generates each method as a generic whose exact `where`/`data` shapes a
hand-written interface can't reproduce without importing your generated client.
This is what lets a real `PrismaClient` be assignable so you can pass it directly.

The `authUser` delegate now also needs `findMany` (used by `findByIds`). A real
`PrismaClient` has it; only a hand-written stub of `PrismaAuthClient` needs the
method added.

## License

MIT
