<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/teams-prisma

**Prisma-backed** implementations of the [`@basaltkit/teams`](https://github.com/basaltkit/basalt/tree/main/packages/teams)
stores — **memberships** and **invitations** — for production databases
(PostgreSQL, MySQL, …).

You bring a generated `PrismaClient` whose schema includes the `Team*` models;
the stores only touch those delegates, so they layer onto your existing client
without owning your schema. It's the production counterpart to
[`@basaltkit/teams-sqlite`](https://github.com/basaltkit/basalt/tree/main/packages/teams-sqlite)
(the zero-dependency, single-node option) — same store contracts.

```bash
pnpm add @basaltkit/teams-prisma   # peer: @basaltkit/teams ; you already have @prisma/client
```

## 1. Add the models

Copy the models from the bundled reference schema (`@basaltkit/teams-prisma/schema.prisma`)
into your `schema.prisma`:

```prisma
model TeamMembership {
  tenantId  String
  userId    String
  role      String
  createdAt DateTime
  @@id([tenantId, userId])
  @@map("team_memberships")
}
model TeamInvitation {
  id         String    @id
  tenantId   String
  email      String
  role       String
  token      String    @unique
  invitedBy  String?
  expiresAt  DateTime
  acceptedAt DateTime?
  revokedAt  DateTime?
  @@index([tenantId, email])
  @@map("team_invitations")
}
```

Then `prisma migrate dev` and `prisma generate`.

## 2. Wire the stores

`prismaTeamsStores(prisma)` returns both stores named to drop straight into
`teamsPlugin` — pass your client directly, no cast:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { prismaTeamsStores } from '@basaltkit/teams-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const t = prismaTeamsStores(prisma)

createApp({
  plugins: [teamsPlugin({ memberships: t.memberships, invitations: t.invitations })],
})
```

Each store is also exported on its own (`PrismaMembershipStore`,
`PrismaInvitationStore`) and takes the client in its constructor.

| Export | Contract | Model |
| --- | --- | --- |
| `PrismaMembershipStore` | `MembershipStore` | `TeamMembership` |
| `PrismaInvitationStore` | `InvitationStore` | `TeamInvitation` |

## Multi-tenant?

Pair with [`@basaltkit/prisma`](https://github.com/basaltkit/basalt/tree/main/packages/prisma)
to resolve the per-tenant client from the request context and build the stores
over it.

## Notes

- **Time** is stored as `DateTime`; the `@basaltkit/teams` contracts model it as
  epoch-ms `number`, and the stores convert at the boundary.
- **`add()` upserts** a membership (matches the in-memory `Map.set` semantics),
  keyed on the `@@id([tenantId, userId])` compound id.
- **Pending** invitations are those with `acceptedAt` and `revokedAt` both null;
  expiry is the caller's concern, exactly as in the in-memory store.
- `markAccepted`/`revoke` use `updateMany`, so they're tolerant no-ops if the row
  is gone — same semantics as the in-memory and SQLite stores.

## Typing note

`PrismaTeamsClient` types delegate **arguments** as `any` (returns stay precise)
so a real `PrismaClient` is assignable and can be passed directly — Prisma's
generated method generics can't be reproduced by a hand-written interface.

## License

MIT
