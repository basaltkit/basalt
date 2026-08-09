# @basaltkit/auth-prisma

**Prisma-backed** implementations of every [`@basaltkit/auth`](https://github.com/Zebedeu/basalt/tree/main/packages/auth)
store — users, sessions, refresh tokens, one-time tokens, API keys and MFA
state — for production databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` whose schema includes the `Auth*` models;
the stores only touch those delegates, so they layer onto your existing client
without owning your schema or connection. It's the production counterpart to
[`@basaltkit/auth-sqlite`](https://github.com/Zebedeu/basalt/tree/main/packages/auth-sqlite)
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
model AuthApiKey         { id String @id  name String  prefix String  hash String @unique  tenantId String?  userId String?  scopes String[]  createdAt DateTime  lastUsedAt DateTime?  revokedAt DateTime?  @@map("auth_api_keys") }
model AuthMfa            { userId String @id  secret String  enabled Boolean @default(false)  recoveryCodes String[]  @@map("auth_mfa") }
```

Then `prisma migrate dev` (or `prisma db push`) and `prisma generate`.

> `scopes` and `recoveryCodes` use PostgreSQL scalar lists (`String[]`). On a
> database without scalar-list support (e.g. SQLite), model them as `Json` and
> adapt — or just use `@basaltkit/auth-sqlite`.

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

## Multi-tenant?

Pair with [`@basaltkit/prisma`](https://github.com/Zebedeu/basalt/tree/main/packages/prisma):
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

## License

MIT
