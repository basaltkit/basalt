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

## Error codes

| Error | Code | HTTP |
| --- | --- | --- |
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 |

## Events

| Hook | Payload |
| --- | --- |
| `team:invited` | `{ invitation, token }` — send the email here |
| `team:joined` | `{ membership }` |
| `team:role_changed` | `{ membership }` |
| `team:member_removed` | `{ tenantId, userId }` |

The full flow — including email plumbing — is in the
[account lifecycle cookbook](/cookbook/account-lifecycle).
