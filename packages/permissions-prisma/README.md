# @basaltkit/permissions-prisma

**Prisma-backed** implementation of the [`@basaltkit/permissions`](https://github.com/Zebedeu/basalt/tree/main/packages/permissions)
`AccessStore` — role assignments and permission grants — for production
databases (PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` with the three `Perm*` models; the store
only touches those delegates. The production counterpart to
[`@basaltkit/permissions-sqlite`](https://github.com/Zebedeu/basalt/tree/main/packages/permissions-sqlite).

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

## Notes

- Role assignments and permission grants are **sets** — every write is a
  `createMany({ skipDuplicates: true })`, so re-granting is a harmless no-op.
- Everything is **scoped**; grants never leak between scopes.
- `PrismaPermissionsClient` types delegate **arguments** as `any` (returns stay
  precise) so a real `PrismaClient` is assignable and passes directly.

## License

MIT
