<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/permissions-prisma

**Prisma-backed** implementation of the [`@basaltkit/permissions`](https://github.com/basaltkit/basalt/tree/main/packages/permissions)
`AccessStore` — role assignments and permission grants — plus durable
`TemporaryGrantStore` and `DelegationStore`, for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the `Perm*` models; the stores only
touch those delegates. The production counterpart to
[`@basaltkit/permissions-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/permissions-sqlite).

```bash
pnpm add @basaltkit/permissions-prisma   # peer: @basaltkit/permissions ; you already have @prisma/client
```

## 1. Add the models

Copy the models from the bundled reference schema
(`@basaltkit/permissions-prisma/schema.prisma`) into your `schema.prisma`:

```prisma
model PermUserRole       { scope String  userId String  role String        @@id([scope, userId, role])       @@map("perm_user_roles") }
model PermUserPermission { scope String  userId String  permission String  @@id([scope, userId, permission]) @@map("perm_user_permissions") }
model PermRolePermission { scope String  role String    permission String  @@id([scope, role, permission])   @@map("perm_role_permissions") }
```

Time-boxed grants (`gate.grantTemporarily()`) and delegations (`gate.delegate()`)
need two more models — only if you wire those stores:

```prisma
model PermTemporaryGrant {
  id          String   @id
  scope       String
  userId      String
  permissions String[]
  expiresAt   DateTime
  grantedBy   String?
  reason      String?

  @@index([scope, userId, expiresAt])
  @@index([expiresAt])
  @@map("perm_temporary_grants")
}

model PermDelegation {
  id          String    @id
  scope       String
  fromUserId  String
  toUserId    String
  permissions String[]
  createdAt   DateTime
  expiresAt   DateTime? // NULL = open-ended

  @@index([scope, toUserId])
  @@index([scope, fromUserId])
  @@index([expiresAt])
  @@map("perm_delegations")
}
```

Then `prisma migrate dev` and `prisma generate`. (`basalt prisma:sync` copies
all five.)

## 2. Wire the store

```ts
import { permissionsPlugin } from '@basaltkit/permissions'
import { prismaAccessStore } from '@basaltkit/permissions-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const p = prismaAccessStore(prisma)   // pass your client directly, no cast

createApp({
  plugins: [
    permissionsPlugin({
      store: p.store,
      // Optional — need the PermTemporaryGrant / PermDelegation models:
      temporaryGrants: p.temporaryGrants,
      delegations: p.delegations,
    }),
  ],
})
```

`temporaryGrants` and `delegations` look their model up on first use, so an app
that does not wire them needs neither model (and a client generated before they
existed still type-checks). They filter `expiresAt > now`, user and scope in the
query — the Gate re-checks every row anyway — and keep expired rows inert until
`pruneExpired(now?)` deletes them (run it from a scheduled job).

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `prismaAccessStore(client, options?)` | function | Validates the client and returns `{ store, temporaryGrants, delegations }`, named to drop straight into `permissionsPlugin`. |
| `PrismaAccessStore` | class | The `AccessStore` implementation. `new PrismaAccessStore(client, options?)` — use it directly to share a client across stores. |
| `PrismaTemporaryGrantStore` | class | Durable `TemporaryGrantStore` (`PermTemporaryGrant`). `new PrismaTemporaryGrantStore(client, options?)`; adds `pruneExpired(now?)` → rows deleted. |
| `PrismaDelegationStore` | class | Durable `DelegationStore` (`PermDelegation`). `new PrismaDelegationStore(client, options?)`; `pruneExpired(now?)` deletes delegations past their deadline (open-ended ones stay). |
| `PermTemporaryGrantRow` / `PermDelegationRow` | interface | The row shapes the stores read. |
| `permissionsMysqlColumnLimits` / `ColumnLengthError` | const / class | The MySQL preset and the error the guard throws. |
| `PrismaPermissionsClient` | interface | The delegates the stores touch: `permUserRole`, `permUserPermission`, `permRolePermission`, and the optional `permTemporaryGrant`, `permDelegation`. |
| `PrismaPermissionsStores` | interface | `{ store, temporaryGrants, delegations }`. |

`prismaAccessStore` takes one option, `columnLimits` (`'mysql'` or your own
limits — see [MySQL](#mysql)); unset, nothing is checked. Everything else (scope semantics, wildcards, super-admin) belongs to
`@basaltkit/permissions`.

## MySQL

The reference schema above is written for PostgreSQL (and works on SQLite),
where a bare `String` is `TEXT`. **On MySQL Prisma makes it `VARCHAR(191)`**,
and a server outside strict mode truncates a longer value silently — the write
succeeds, and the value read back is not the one written. Two long permission names cut to the same prefix collapse into one grant. Every column of the three grant tables is part of a composite primary key, so the MySQL variant keeps them all at `VARCHAR(191)` (three per key fit InnoDB's 3 072-byte limit); the guard refuses a longer role, permission, user id or scope, and checks a whole `grantToRole`/`grantToUser` batch before writing any of it. In `PermTemporaryGrant` and `PermDelegation` the ids, user ids, scope and `grantedBy` stay `VARCHAR(191)`, the free-text `reason` is `TEXT`, and `permissions` is `Json` (MySQL has no scalar lists; the stores read either form).

- Copy **`schema.mysql.prisma`** instead (exported as
  `@basaltkit/permissions-prisma/schema.mysql.prisma`; `basalt prisma:sync` picks it when
  your datasource is `mysql`): the free-text columns are widened with native
  types, the keys stay `VARCHAR(191)` so they can be indexed.
- Turn on the guard, so a value that still would not fit is **refused**
  (`ColumnLengthError`, code `COLUMN_LENGTH_EXCEEDED`, status 422, nothing
  written) instead of cut:

  ```ts
  prismaAccessStore(prisma, { columnLimits: 'mysql' })
  ```

  `'mysql'` is `permissionsMysqlColumnLimits` — the capacities of `schema.mysql.prisma`. A number is
  a limit in characters (`VARCHAR(n)`), `{ bytes: n }` a limit in UTF-8 bytes
  (the `TEXT` family). Widened a column yourself? Spread the preset and raise it:
  `{ PermRolePermission: { ...permissionsMysqlColumnLimits.PermRolePermission, permission: 255 } }`.
- Keep MySQL in strict mode (`STRICT_TRANS_TABLES`) as well.

Unset (the default), nothing is checked — PostgreSQL and SQLite are unaffected.
See the [MySQL section of the persistence guide](https://basaltkit-docs.pages.dev/guide/persistence#mysql).

## Notes

- Role assignments and permission grants are **sets** — every write is a
  `createMany({ skipDuplicates: true })`, so re-granting is a harmless no-op.
- Everything is **scoped**; grants never leak between scopes.
- `PrismaPermissionsClient` types delegate **arguments** as `any` (returns stay
  precise) so a real `PrismaClient` is assignable and passes directly.

## Errors

This package defines no `BasaltError` subclasses and no error codes.

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `TypeError` | — | — | A direct write (`assignRole`, `removeRole`, `grantToRole`, `grantToUser`) with an empty or non-string user id, role name or scope, or a permission list that is not an array of non-empty strings. Refused before Prisma is called: `''`/`null`/`undefined` would otherwise share one "nobody" key. Also `add()` on the temporary-grant / delegation stores with such a field, a non-string `grantedBy`/`reason`, or an `expiresAt`/`createdAt` that is not a finite timestamp a `DateTime` can hold. |
| `ColumnLengthError` | `COLUMN_LENGTH_EXCEEDED` | 422 | With `columnLimits`, a user id, role, permission, scope (or a temporary grant's / delegation's id, `grantedBy`, `reason`) is longer than its column. Checked before the write: a refused batch writes nothing. |
| `Error` | — | first use | `temporaryGrants` / `delegations` used with a client that has no `permTemporaryGrant` / `permDelegation` model — the message names the model and points at `basalt prisma:sync`. |
| `Error` | — | boot / first use | The client has no `permUserRole` model. `prismaAccessStore()` fails fast with a message naming the missing model and pointing at `basalt prisma:sync`, instead of a cryptic "reading 'findMany' of undefined". A lazy/proxy client (database-per-tenant) skips the check and is validated on first query. |

Prisma's own errors (connection, constraint) propagate unchanged. The
authorization errors a client sees — `PERMISSION_DENIED`, `AUTH_REQUIRED`,
`PERMISSION_META_INVALID` — come from `@basaltkit/permissions`.

## Hooks & events

None.

Guides: [Authorization](/guide/authorization) · [Persistence](/guide/persistence).

## License

MIT
