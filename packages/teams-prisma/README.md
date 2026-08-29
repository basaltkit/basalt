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

## Exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `prismaTeamsStores(client)` | function | Validates the client and returns `{ memberships, invitations }` for `teamsPlugin`. |
| `PrismaMembershipStore` | class | `MembershipStore` over the `TeamMembership` model. `new PrismaMembershipStore(client)`. |
| `PrismaInvitationStore` | class | `InvitationStore` over the `TeamInvitation` model. `new PrismaInvitationStore(client)`. |
| `PrismaTeamsClient` | interface | The two delegates the stores touch: `teamMembership`, `teamInvitation`. |
| `PrismaTeamsStores` | interface | `{ memberships, invitations }`. |

`prismaTeamsStores` takes the client only — there are no options. Role ranks,
invite TTL and the escalation guard all belong to `teamsPlugin`.

The `token` column holds the **SHA-256 hash** of the invitation token, never the
raw value — `@basaltkit/teams` hashes before it reaches the store, so the
`@unique` index is on the hash.

## Errors

This package defines no `BasaltError` subclasses and no error codes.

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `Error` | — | boot / first use | The client has no `teamMembership` model. `prismaTeamsStores()` fails fast with a message naming the missing model and pointing at `basalt prisma:sync`, instead of a cryptic "reading 'create' of undefined". A lazy/proxy client (database-per-tenant) skips the check and is validated on first query. |

Prisma's own errors (connection, unique constraint) propagate unchanged. The
team errors a client sees — `TEAM_INVITE_INVALID`, `TEAM_NOT_A_MEMBER`,
`TEAM_ROLE_REQUIRED`, `TEAM_LAST_OWNER` — come from `@basaltkit/teams`.

## Hooks & events

None. `team:invited` / `team:joined` / `team:role_changed` /
`team:member_removed` are emitted by `@basaltkit/teams`.

Guides: [Teams](/guide/teams) · [Persistence](/guide/persistence).

## License

MIT
