<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/auth-prisma

**Prisma-backed** implementations of every [`@basaltkit/auth`](https://github.com/basaltkit/basalt/tree/main/packages/auth)
store — users, sessions, refresh tokens, one-time tokens, API keys, MFA
state, OAuth/OIDC account links and WebAuthn passkeys — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` whose schema includes the `Auth*` models;
the stores only touch those delegates, so they layer onto your existing client
without owning your schema or connection. It's the production counterpart to
[`@basaltkit/auth-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/auth-sqlite)
(the zero-dependency, single-node option) — same store contracts, different
backend.

```bash
pnpm add @basaltkit/auth-prisma   # peer: @basaltkit/auth 5.x ; you already have @prisma/client
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
model AuthSession        { id String @id  userId String  expiresAt DateTime  lastSeenAt DateTime?  @@index([userId]) @@map("auth_sessions") }
model AuthRefreshToken   { token String @id  familyId String  userId String  expiresAt DateTime  usedAt DateTime?  @@index([familyId]) @@index([userId]) @@map("auth_refresh_tokens") }
model AuthToken          { token String @id  userId String  purpose String  expiresAt DateTime  usedAt DateTime?  @@index([userId, purpose]) @@map("auth_tokens") }
model AuthApiKey         { id String @id  name String  prefix String  hash String @unique  tenantId String?  userId String?  scopes String[]  createdAt DateTime  expiresAt DateTime?  lastUsedAt DateTime?  revokedAt DateTime?  serviceId String?  previousHash String? @unique  previousHashExpiresAt DateTime?  rotatedAt DateTime?  allowedIps String[] @default([])  meta Json?  @@index([serviceId]) @@map("auth_api_keys") }
model AuthMfa            { userId String @id  secret String  enabled Boolean @default(false)  recoveryCodes String[]  lastUsedStep Int?  @@map("auth_mfa") }
model AuthTokenVersion   { userId String @id  version Int @default(0)  @@map("auth_token_versions") }
model AuthAccountLink    { id String @id  provider String  subject String  userId String  email String  createdAt DateTime  @@index([userId]) @@map("auth_account_links") }
model AuthPasskey        { id String @id  credentialId String  userId String  publicKey String  counter BigInt  transports String?  deviceName String?  createdAt DateTime  lastUsedAt DateTime?  @@index([userId]) @@map("auth_passkeys") }
```

Then `prisma migrate dev` (or `prisma db push`) and `prisma generate`.

> `scopes` and `recoveryCodes` use PostgreSQL scalar lists (`String[]`). On a
> database without scalar-list support, model them as `Json` (the stores read
> either form) — as the MySQL variant does — or, for SQLite, just use
> `@basaltkit/auth-sqlite`.
>
> **MySQL:** use `schema.mysql.prisma` instead — see [MySQL](#mysql).

## Session idle timeout (2.1)

`authPlugin({ sessionIdleTtl })` needs a session store that records activity.
`PrismaSessionStore` does so only when asked, because it writes a column an
existing database may not have yet:

1. Add `lastSeenAt DateTime?` to `AuthSession` (it is in the reference schemas)
   and migrate — `prisma migrate dev --name auth_session_last_seen`, in every
   tenant schema with schema-per-tenant. On PostgreSQL:
   `ALTER TABLE "auth_sessions" ADD COLUMN "lastSeenAt" TIMESTAMP(3);`
2. Turn it on: `prismaAuthStores(prisma, { trackSessionActivity: true })` (or
   `new PrismaSessionStore(prisma, { trackSessionActivity: true })`).

Without the option nothing changes: no column is read or written, and
`authPlugin` refuses `sessionIdleTtl` at boot instead of not enforcing it.
Sessions written before `trackSessionActivity` was on (`lastSeenAt` null) start
their idle clock on their next use. Rows written with it on record their
creation time, and nothing updates it while `sessionIdleTtl` is off, so turning
the idle timeout on later signs out sessions older than the window once.

## Upgrading to 3.0

3.0.0 stores the API key lifecycle of `@basaltkit/auth` 5.0: rotation with a
grace window, service keys, a per-key IP allowlist and metadata. It requires
`@basaltkit/auth` 5 (peer `^5.0.0`) and the six new columns in the database;
upgrade both in the same change (`create-basalt update` does). `AuthApiKey`
gains six columns: `serviceId`, `previousHash` (unique), `previousHashExpiresAt`,
`rotatedAt`, `allowedIps` and `meta`. `PrismaApiKeyStore` now implements the
optional `ApiKeyStore.update`, and `findByHash` also looks a key up by its
previous hash.

This is a major because the database **and** the generated client must both
have the columns. Prisma selects every column of the model, so a client
generated from the new schema fails every API-key query until the database is
migrated. A client generated from the old schema fails the new
`previousHash` lookup. Copy the model from the reference schema by hand,
`@basaltkit/auth-prisma/schema.prisma` (or `schema.mysql.prisma` on MySQL;
`basalt prisma:sync` only adds missing models, never new fields to an existing
one), run
`prisma generate`, then create the migration:

```bash
prisma migrate dev --name add_api_key_lifecycle
```

`migrate dev` warns that a unique constraint on `previousHash` will be added and
may fail on duplicate values. That is safe here: the column is new, so every
existing row holds `NULL`, and `NULL`s never collide. `migrate dev` also refuses
to run in a non-interactive shell (CI, a container, an agent). There, generate
the SQL and apply it with `migrate deploy`:

```bash
mkdir -p prisma/migrations/20261011000000_add_api_key_lifecycle
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script \
  > prisma/migrations/20261011000000_add_api_key_lifecycle/migration.sql
prisma migrate deploy
```

`--to-schema` is your app's schema file, whatever the database. Or paste
`API_KEY_LIFECYCLE_MIGRATION_SQL.postgresql` (or `.mysql`) into that
`migration.sql` — it is the same statements as below.

On PostgreSQL the generated migration is:

```sql
ALTER TABLE "auth_api_keys" ADD COLUMN "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "meta" JSONB,
ADD COLUMN "previousHash" TEXT,
ADD COLUMN "previousHashExpiresAt" TIMESTAMP(3),
ADD COLUMN "rotatedAt" TIMESTAMP(3),
ADD COLUMN "serviceId" TEXT;
CREATE UNIQUE INDEX "auth_api_keys_previousHash_key" ON "auth_api_keys"("previousHash");
CREATE INDEX "auth_api_keys_serviceId_idx" ON "auth_api_keys"("serviceId");
```

On MySQL (`schema.mysql.prisma`):

```sql
ALTER TABLE `auth_api_keys` ADD COLUMN `allowedIps` JSON NULL,
  ADD COLUMN `meta` JSON NULL,
  ADD COLUMN `previousHash` VARCHAR(191) NULL,
  ADD COLUMN `previousHashExpiresAt` DATETIME(3) NULL,
  ADD COLUMN `rotatedAt` DATETIME(3) NULL,
  ADD COLUMN `serviceId` VARCHAR(191) NULL;
CREATE UNIQUE INDEX `auth_api_keys_previousHash_key` ON `auth_api_keys`(`previousHash`);
CREATE INDEX `auth_api_keys_serviceId_idx` ON `auth_api_keys`(`serviceId`);
```

All the new columns are nullable (or default to an empty list), so existing keys
keep working unchanged. **Schema-per-tenant:** add the migration to your tenant
migrations and run `basalt tenant:migrate`, so every tenant schema gets the
columns. Until they exist, `PrismaApiKeyStore` throws `ApiKeySchemaOutdatedError`
(`AUTH_API_KEY_SCHEMA_OUTDATED`) with this SQL, keeping the original Prisma error
as `cause`. That covers both a P2022 "column does not exist" and a stale
client's "Unknown argument `previousHash`". The SQL is also exported as
`API_KEY_LIFECYCLE_MIGRATION_SQL`.

`columnLimits: 'mysql'` also bounds `serviceId` and `previousHash` (VARCHAR(191)).
A cleared allowlist is stored as `[]` and cleared metadata as `{}`; both read
back as absent.

## Upgrading to 2.0

- **New models `AuthAccountLink` and `AuthPasskey`.** Copy them from the
  reference schema (or `basalt prisma:sync`) and migrate —
  `prisma migrate dev --name auth_account_links_passkeys`, in every tenant schema
  with schema-per-tenant. They back `s.accountLinks` (OAuth/OIDC logins bound to
  the provider's subject) and `s.passkeys` (a durable `PasskeyStore` with an
  atomic `compareAndSetCounter`). The delegates are optional in
  `PrismaAuthClient`: a client generated without them still compiles, and those
  two stores throw `AuthModelMissingError` (`AUTH_PRISMA_MODEL_MISSING`) at first
  use.
- **Legacy mixed-case emails.** On PostgreSQL `findByEmail` matches
  case-insensitively and **refuses ambiguity**: when two rows differ only in
  letter case it throws `AccountEmailAmbiguousError` (`AUTH_EMAIL_AMBIGUOUS`)
  instead of returning one, and `create` refuses a case variant of an existing
  row with `EmailTakenError`. Run the one-off helper after upgrading:

  ```ts
  import { normalizeAuthUserEmails } from '@basaltkit/auth-prisma'

  const report = await normalizeAuthUserEmails(prisma, { dryRun: true }) // preview
  // { normalized: [{ id, from, to }], conflicts: [{ email, ids }] }
  await normalizeAuthUserEmails(prisma) // lowercases the lone mixed-case rows
  ```

  `conflicts` are left for you to merge (which account is the real one is a
  human decision). MySQL's case-insensitive collation already rules out such
  twins; there the exact lookup is used and the insensitive probe is not retried.
- `PrismaAuthClient.authUser` no longer needs `findFirst` (a real client is
  unaffected; a hand-written stub needs `findMany` to honour `where.email` with
  `mode: 'insensitive'`, `orderBy` and `take`).

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
import { PrismaPg } from '@prisma/adapter-pg'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })

const prisma = new PrismaClient({ adapter })
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
      accountLinks: s.accountLinks, // OAuth/OIDC: provider subject → account
    }),
    apiKeysPlugin({ store: s.apiKeys, users: s.users }),
    webauthnPlugin({ config, verifier, credentials: s.passkeys }),
  ],
}).boot()
```

Every store is also exported on its own (`PrismaUserSource`, `PrismaSessionStore`,
…) and takes the client (and optional `{ columnLimits }`, see [MySQL](#mysql))
in its constructor, so you can mix backends.

| Export | Contract | Model |
| --- | --- | --- |
| `PrismaUserSource` | `UserSource` | `AuthUser` |
| `PrismaSessionStore` | `SessionStore` | `AuthSession` |
| `PrismaRefreshTokenStore` | `RefreshTokenStore` | `AuthRefreshToken` |
| `PrismaAuthTokenStore` | `AuthTokenStore` | `AuthToken` |
| `PrismaApiKeyStore` | `ApiKeyStore` | `AuthApiKey` |
| `PrismaMfaStore` | `MfaStore` | `AuthMfa` |
| `PrismaTokenVersionStore` | `TokenVersionStore` | `AuthTokenVersion` |
| `PrismaAccountLinkStore` | `AccountLinkStore` | `AuthAccountLink` |
| `PrismaPasskeyStore` | `PasskeyStore` | `AuthPasskey` |

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

## MySQL

The reference schema above is written for PostgreSQL, where a bare `String` is
`TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**, and a server outside
strict mode truncates a longer value silently — the write succeeds, and the
value read back is not the one written. A cut password hash never verifies
again, a cut sealed TOTP secret no longer opens, a cut passkey public key no
longer checks a signature.

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/auth-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it
  when your datasource is `mysql`). It widens `AuthUser.email` to
  `VARCHAR(254)` and makes `passwordHash`, the API key `name`, the MFA
  `secret`, the account link `subject`/`email` and the passkey
  `credentialId`/`publicKey`/`transports`/`deviceName` `TEXT`; `scopes` and
  `recoveryCodes` become `Json` (MySQL has no scalar lists). The keys stay
  `VARCHAR(191)` so they can be indexed — every indexed column is short by
  design (hashed tokens and session ids; the `id` of `AuthAccountLink` and
  `AuthPasskey` is a SHA-256 of the natural key, since an OIDC `sub` runs to
  255 characters and a credential id to 1 023 bytes).
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaAuthStores(prisma, { columnLimits: 'mysql' })
  ```

  Each store class takes the same option (`new PrismaUserSource(prisma, {
  columnLimits: 'mysql' })`). `'mysql'` is `authMysqlColumnLimits` — the
  capacities of `schema.mysql.prisma`. A number is a limit in characters
  (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes (the `TEXT` family).
  Widened a column yourself? Spread the preset and raise it:
  `{ AuthUser: { ...authMysqlColumnLimits.AuthUser, id: 255 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

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
