# Teams

`@basaltkit/teams` turns a tenant into a **multi-user team**: members with ranked
roles, and email invitations to join. It's decoupled from auth and tenancy —
identifiers are read from the request context — and can mirror role changes into
[`@basaltkit/permissions`](/guide/security).

[[toc]]

## Setup

Teams reads the current tenant from `ctx().tenant` (set by tenancy) and the
acting user from `ctx().user` (set by auth), so register all three. This is the
full wiring, including seeding the first owner and turning the invite hook into
an email:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@basaltkit/tenancy'
import { teamsPlugin, teamRoutes, TEAMS } from '@basaltkit/teams'

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source: new MemoryTenantSource().add({ id: 'acme' }),
      resolvers: [headerResolver()], // reads x-tenant-id in dev
    }),
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    teamsPlugin(),
    fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes()] }),
  ],
}).boot()

// Send the invitation email when one is created (see Invitations below)
app.hooks.on('team:invited', ({ invitation, token }) =>
  mailer.send(invitation.email, `https://app.example.com/invite?token=${token}`))

// Seed the first owner when the tenant is created — invitations are for the rest
await app.container.get(TEAMS).addMember('acme', 'ada-id', 'owner')
```

Requests then carry `Authorization: Bearer <login token>` and a tenant identifier
(`x-tenant-id: acme` with `headerResolver`, or a subdomain in production).

::: tip Tenant-scoped
Everything is isolated per tenant: memberships, invitations, and the `teamRole`
guard all key off `ctx().tenant.id`. A user can be an `owner` of one team and a
`member` of another.
:::

## Durable stores (production)

The default `Memory*` stores forget everything on restart. Swap in a durable
backend and rosters and pending invitations survive a redeploy.

### SQLite — `@basaltkit/teams-sqlite`

Zero external dependencies, built on `node:sqlite` (Node 22.5+):

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'

const t = sqliteTeamsStores('./data/teams.db') // ':memory:' by default; opens + migrates
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

### Prisma — `@basaltkit/teams-prisma`

For PostgreSQL/MySQL. Copy the `TeamMembership` / `TeamInvitation` models from
`@basaltkit/teams-prisma/schema.prisma`, run `prisma migrate dev && prisma generate`, then:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { prismaTeamsStores } from '@basaltkit/teams-prisma'
import { PrismaClient } from '@prisma/client'

const t = prismaTeamsStores(new PrismaClient())
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

Individual stores (`SqliteMembershipStore`, `PrismaMembershipStore`, …) are
exported too, and take a `DatabaseSync` / `PrismaClient` in their constructor.

## Roles

Roles are a ranked hierarchy — higher outranks lower, so a route that requires
`admin` also accepts `owner`:

| Role | Rank |
| --- | --- |
| `owner` | 3 |
| `admin` | 2 |
| `member` | 1 |

Roles are free-form strings; override the hierarchy with a name → rank map (roles
outside the map have rank 0):

```ts
teamsPlugin({ roleRank: { owner: 4, admin: 3, editor: 2, viewer: 1 } })
```

A team always keeps at least one owner — the service refuses to demote or remove
the last one (`LastOwnerError`, `TEAM_LAST_OWNER`). Promote someone else first.

::: tip No privilege escalation through invites or role changes
The HTTP routes pass the acting user to the service (`actingUserId`), which then
enforces two rules: the actor can never grant a role **above their own rank**
(an `admin` can't invite or promote anyone — including themselves — to
`owner`), and can never re-role or demote a member who currently **outranks**
them. Violations throw `InsufficientTeamRoleError` (`403 TEAM_ROLE_REQUIRED`).
Service calls without `actingUserId` (trusted server-side seeding) skip the
check.
:::

## Seeding the first owner

Invitations enroll members, but the first owner is seeded directly — typically
when the tenant is created:

```ts
import { TEAMS } from '@basaltkit/teams'
await app.container.get(TEAMS).addMember(tenant.id, creator.id, 'owner')
```

## Routes

`teamRoutes()` registers, all scoped to the current tenant (no tenant in context
→ `400 TEAM_NO_TENANT`):

| Endpoint | Requires |
| --- | --- |
| `POST /team/invites` `{ email, role? }` | `admin` |
| `POST /team/invites/accept` `{ token }` | login |
| `GET /team/invites` · `DELETE /team/invites/:id` | `admin` |
| `GET /team/members` | `member` |
| `PATCH /team/members/:userId` `{ role }` | `admin` |
| `DELETE /team/members/:userId` | `admin` |

## Role guard

`teamsPlugin` registers the `teamRole` guard: the current user must hold the
required role — or a higher-ranked one — in the current tenant. Missing user
**or** tenant in context → `403 TEAM_NOT_A_MEMBER`; insufficient role →
`403 TEAM_ROLE_REQUIRED`:

```ts
import { route } from '@basaltkit/fastify'

route({
  method: 'POST',
  url: '/projects',
  meta: { auth: true, teamRole: 'admin' }, // member → 403 TEAM_ROLE_REQUIRED
  async handler() { return { created: true } },
})
```

`teamsPlugin` claims the `teamRole` key in the adapters' boot-time guarded-meta
check — declaring `meta.teamRole` on a route **without** registering the plugin
refuses to boot with `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`)
instead of silently serving the route unguarded. The same mechanism covers
`meta.auth` and `meta.can` — see the
[guard/meta table in the authorization guide](/guide/authorization#mental-model)
and the [adapters guide](/guide/adapters).

## Tenant isolation guard (`tenantMembershipPlugin`)

`meta.teamRole` protects the routes you remember to annotate.
`tenantMembershipPlugin` closes the remaining gap **app-wide**: on *every*
request that has both an authenticated user and a resolved tenant, it asserts
the user actually holds a membership in that tenant — so a valid user of tenant
A can never operate on tenant B just by sending `x-tenant-id: b` or the right
`Host` header. Tenant *resolution* is identification, never authorization.

```ts
import { teamsPlugin, tenantMembershipPlugin } from '@basaltkit/teams'

createApp({
  plugins: [
    authPlugin(/* … */),
    tenancyPlugin(/* … */),
    teamsPlugin(/* … */),
    tenantMembershipPlugin(), // membership enforced everywhere, by default
  ],
})
```

A non-member gets `403 TEAM_NOT_A_MEMBER`. The guard is skipped when the
request has no resolved tenant or no user (central/anonymous traffic), and for
routes that opt out explicitly with `meta: { central: true }` — login, tenant
creation, platform admin, invite acceptance: routes that legitimately act
across or outside a single tenant.

Three behaviours to know:

- **Existence, not rank, by default.** The guard asks "does a membership record
  exist?", not "does the role outrank `member`?" — so a genuine member holding
  a custom role that's absent from `roleRank` (rank 0) is not rejected. Pass
  `role: 'member'` (or higher) to switch to rank semantics.
- **`exempt` is the WHO-based escape hatch.** For identities that legitimately
  cross tenants (platform admins, support impersonation), give a predicate over
  the request context: `exempt: ({ user }) => user?.platformAdmin === true`.
  Prefer it over `meta.central` when the exemption is about *who is calling* —
  `central` disables the guard for **everyone** on that route. Exemption
  results are **never cached**.
- **The decision cache is opt-in.** Without it, every guarded request costs one
  membership lookup (a single indexed PK read — usually fine). With
  `cache: { ttlMs, maxEntries }`, decisions are cached in-process and dropped
  **immediately** by the `team:joined` / `team:role_changed` /
  `team:member_removed` hooks — same-process changes are always exact. `ttlMs`
  only bounds staleness for changes made on *another replica*: a member removed
  elsewhere may retain access for up to `ttlMs`. The map is size-bounded by
  `maxEntries` (default 10 000, oldest evicted).

```ts
tenantMembershipPlugin({
  role: 'member',                      // optional: rank semantics instead of existence
  exempt: ({ user }) => (user as { platformAdmin?: boolean })?.platformAdmin === true,
  cache: { ttlMs: 30_000, maxEntries: 10_000 },
})
```

::: tip Pair it with billing
`billingRoutes()` / `invoiceRoutes()` authenticate the *user* but resolve the
*billable* from the tenant — with this guard registered, a user of tenant A
calling checkout/portal/invoices with tenant B's identifier is stopped with
`403 TEAM_NOT_A_MEMBER` before any billing code runs. See
[Billing](/guide/billing) and the [security guide](/guide/security).
:::

## Invitations (invite → accept)

`POST /team/invites` mints a one-time, expiring token (default 7 days) and emits
`team:invited` carrying it. **The token is emailed — never returned over HTTP.**
A fresh invite for the same address supersedes any pending one (one pending
invite per email per team). Over HTTP:

```bash
# 1. An admin invites Bob (201; response never contains the token)
curl -X POST http://localhost:3000/team/invites \
  -H 'authorization: Bearer <admin token>' -H 'x-tenant-id: acme' \
  -H 'content-type: application/json' \
  -d '{"email":"bob@example.com","role":"member"}'

# 2. Bob follows the emailed link, logs in, then accepts with the token
curl -X POST http://localhost:3000/team/invites/accept \
  -H 'authorization: Bearer <bob token>' -H 'x-tenant-id: acme' \
  -H 'content-type: application/json' -d '{"token":"<token-from-email>"}'
```

The same flow with the `Teams` service (reached via the `TEAMS` token):

```ts
import { TEAMS } from '@basaltkit/teams'
const teams = app.container.get(TEAMS)

const { invitation, token } = await teams.invite({
  tenantId: 'acme', email: 'bob@example.com', role: 'member', invitedBy: 'ada-id',
})
// invitation is PublicInvitation (no token); token goes in the email link
const membership = await teams.accept(token, 'bob-id')
// → { tenantId: 'acme', userId: 'bob-id', role: 'member', createdAt }
```

Two safety properties are built in:

- **Tokens are stored hashed.** Only the SHA-256 of the token is persisted — a
  leak of the invitations table can't be replayed to join a team; the raw token
  lives only in the emailed link.
- **Acceptance is bound to the invited address.** The accept route passes the
  caller's email (`ctx().user.email`) as `acceptingEmail`; a forwarded or
  leaked link redeemed by a *different* account fails with the same
  `TEAM_INVITE_INVALID` as a bogus token — a wrong recipient can't distinguish
  a real token from a fake one. In code, pass the caller's **verified** email;
  omit it only for trusted server-side flows.

An unknown, used, revoked, or expired token throws `TeamInviteInvalidError`
(`400 TEAM_INVITE_INVALID`). Wire the email hook once at startup:

```ts
app.hooks.on('team:invited', ({ invitation, token }) =>
  mailer.send(InviteEmail, { url: `${APP_URL}/invite?token=${token}` }, { to: invitation.email }))
```

## Listing members and invites

```ts
const teams = app.container.get(TEAMS)

await teams.members('acme')          // Membership[] — GET /team/members
await teams.pendingInvites('acme')   // PublicInvitation[] — GET /team/invites
await teams.roleOf('acme', 'bob-id') // 'member' | null
await teams.can('acme', 'bob-id', 'admin') // false — member (1) < admin (2)
await teams.changeRole('acme', 'bob-id', 'admin') // PATCH /team/members/:userId
await teams.removeMember('acme', 'bob-id')        // DELETE /team/members/:userId
await teams.revokeInvite(invitationId)            // DELETE /team/invites/:id
```

`changeRole` and `removeMember` throw `LastOwnerError` (`400 TEAM_LAST_OWNER`) if
they would leave the team without an owner.

## Mirroring roles into permissions

Pass an `access` store (a `@basaltkit/permissions` `AccessStore` satisfies the
structural `RoleAssigner`) and every membership change becomes a role grant in
that tenant's scope:

```ts
import { MemoryAccessStore } from '@basaltkit/permissions'
const access = new MemoryAccessStore()
teamsPlugin({ access })
// teams.addMember('acme', 'u1', 'admin') → access.assignRole('u1', 'admin', 'acme')
```

## Options reference

`teamsPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `memberships` | `MembershipStore` | in-memory | Where memberships live — swap for `teams-sqlite`/`teams-prisma` in production |
| `invitations` | `InvitationStore` | in-memory | Where invitations (hashed tokens) live |
| `access` | `RoleAssigner` | — | Mirrors every membership change into a `@basaltkit/permissions` role grant in the tenant's scope |
| `inviteTtl` | `DurationInput` | `'7d'` | Invitation link lifetime |
| `roleRank` | `Record<string, number>` | `{ owner: 3, admin: 2, member: 1 }` | Role hierarchy; roles outside the map have rank 0 |
| `now` | `() => number` | `Date.now` | Injectable clock (tests) |

`tenantMembershipPlugin(options)`:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `role` | `TeamRole` | — (existence check) | Require a minimum *ranked* role instead of any membership record |
| `exempt` | `(context) => boolean` | — | WHO-based escape for cross-tenant identities (platform admin, support); never cached |
| `cache` | `{ ttlMs: number; maxEntries?: number }` | off | Opt-in in-process decision cache; hook-invalidated same-process, `ttlMs` bounds cross-replica staleness, `maxEntries` default 10 000 |

## Failure modes & troubleshooting

| Error | Code | HTTP | When |
| --- | --- | --- | --- |
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 | Token unknown, used, revoked, expired — or redeemed by an account whose email isn't the invited one |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | `tenantMembershipPlugin` found no membership; or a `meta.teamRole` route ran with no user **or** no tenant in context |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 | Role rank below the required one — including an actor trying to grant/demote above their own rank |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 | The change would leave the team with no owner |
| `TEAM_NO_TENANT` | `TEAM_NO_TENANT` | 400 | A `teamRoutes()` endpoint was called with no tenant in context — register tenancy and send the tenant identifier |
| `TEAM_INVITE_NOT_FOUND` | `TEAM_INVITE_NOT_FOUND` | 404 | `DELETE /team/invites/:id` for an id that doesn't exist or belongs to another tenant |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | A route declares `meta.teamRole` and `teamsPlugin` isn't registered |

- **`TEAM_NOT_A_MEMBER` right after adding a member on another replica** — the
  membership cache's `ttlMs` bounds cross-replica staleness in both directions;
  the decision refreshes within `ttlMs`.
- **A custom role keeps getting `TEAM_ROLE_REQUIRED`** — roles outside
  `roleRank` have rank 0. Add the role to the map, or (for the membership
  guard) rely on the default existence semantics instead of `role:`.
- **`403` on a central route (login, sign-up, tenant creation)** — mark it
  `meta: { central: true }`, or exempt the calling identity with `exempt`.

## Events

| Hook | Payload |
| --- | --- |
| `team:invited` | `{ invitation, token }` — send the email here |
| `team:joined` | `{ membership }` |
| `team:role_changed` | `{ membership }` |
| `team:member_removed` | `{ tenantId, userId }` |

The full flow — including email plumbing — is in the
[account lifecycle cookbook](/cookbook/account-lifecycle).
