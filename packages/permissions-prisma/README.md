<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/permissions-prisma

**Prisma-backed** implementation of the [`@basaltkit/permissions`](https://github.com/basaltkit/basalt/tree/main/packages/permissions)
`AccessStore` — role assignments and permission grants — for production
databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the three `Perm*` models; the store
only touches those delegates. The production counterpart to
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

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the store

```ts
import { permissionsPlugin } from '@basaltkit/permissions'
import { prismaAccessStore } from '@basaltkit/permissions-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const p = prismaAccessStore(prisma)   // pass your client directly, no cast

createApp({ plugins: [permissionsPlugin({ store: p.store })] })
```

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `prismaAccessStore(client)` | function | Validates the client and returns `{ store }`, named to drop straight into `permissionsPlugin({ store })`. |
| `PrismaAccessStore` | class | The `AccessStore` implementation. `new PrismaAccessStore(client)` — use it directly to share a client across stores. |
| `PrismaPermissionsClient` | interface | The three delegates the store touches: `permUserRole`, `permUserPermission`, `permRolePermission`. |
| `PrismaPermissionsStores` | interface | `{ store: PrismaAccessStore }`. |

`prismaAccessStore` takes the client only — there are no options to configure.
Everything else (scope semantics, wildcards, super-admin) belongs to
`@basaltkit/permissions`.

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
| `Error` | — | boot / first use | The client has no `permUserRole` model. `prismaAccessStore()` fails fast with a message naming the missing model and pointing at `basalt prisma:sync`, instead of a cryptic "reading 'findMany' of undefined". A lazy/proxy client (database-per-tenant) skips the check and is validated on first query. |

Prisma's own errors (connection, constraint) propagate unchanged. The
authorization errors a client sees — `PERMISSION_DENIED`, `AUTH_REQUIRED`,
`PERMISSION_META_INVALID` — come from `@basaltkit/permissions`.

## Hooks & events

None.

Guides: [Authorization](/guide/authorization) · [Persistence](/guide/persistence).

## License

MIT
