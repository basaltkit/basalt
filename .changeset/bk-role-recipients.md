---
'@basaltkit/auth': minor
'@basaltkit/auth-prisma': minor
'@basaltkit/auth-sqlite': minor
'@basaltkit/teams': minor
---

Notify everyone with a role without reaching into the auth tables (BK-022).

`teams.members(tenantId)` returns `{ tenantId, userId, role }` and
`@basaltkit/auth` only exposed `users.findById(id)`, so "email every admin of
this tenant" forced an app into either N lookups or reading the auth schema
directly. Both packages now cover it, from opposite ends, without either one
importing the other.

**`@basaltkit/auth`** — `UserSource.findByIds(ids)`, an **optional** bulk
counterpart of `findById`. It resolves `PublicUser[]` (never `AuthUser`: a
directory lookup carries no password hash, MFA secret or any other credential
field), one entry per *found* id in the order of `ids`, duplicates collapsed and
an empty list short-circuited. Implemented in `MemoryUserSource`, and in both
drivers as a single `WHERE id IN (…)` per chunk — `PrismaUserSource` `select`s
only `id`/`email`/`emailVerified` so the hash is never even read, and both chunk
at 500 ids (`idChunkSize`) so a large tenant cannot exceed the driver's
bind-parameter limit. Stores written before this keep compiling.

**`@basaltkit/teams`** — `teamsPlugin({ users })` takes a read-only user
directory (`MemberUserSource`; an `@basaltkit/auth` `UserSource` satisfies it
structurally) and adds:

- `membersWithUsers(tenantId)` — the tenant's memberships with each member's
  `{ id, email, emailVerified }` attached. It is the single place the lookup
  happens: `findByIds` when the source has it, one `findById` per member when it
  doesn't, so apps get the fast path automatically.
- `roleRecipients(tenantId, role, { exact? })` — a filter over it (no extra
  query) honouring `roleRank`: a ranked role includes everyone at or above it,
  an unranked role matches exactly (every unranked role ranks 0, so ranking them
  would notify all of them).
- `teamRoutes({ memberContacts: true })` — opt-in `user` on each entry of
  `GET /team/members`; off by default.

Tenant safety throughout: the ids come from that tenant's membership records and
never from a request, a user the directory returns that was not asked for is
discarded, whatever the directory hands back is projected down to the three safe
fields, and a membership whose account no longer exists is skipped rather than
breaking the list (`user` is required on `TeamMemberWithUser`). Without a `users`
directory the new methods throw `TeamUserSourceMissingError`
(`TEAM_USER_SOURCE_MISSING`, 500).

Note for `@basaltkit/auth-prisma`: the `PrismaAuthClient.authUser` delegate now
also declares `findMany`. A real `PrismaClient` already has it; only a
hand-written stub of that interface needs the method added.
