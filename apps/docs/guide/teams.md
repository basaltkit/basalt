# Teams

`@machize/teams` turns a tenant into a **multi-user team**: members with ranked
roles, and email invitations to join. It's decoupled from auth and tenancy —
identifiers are read from the request context — and can mirror role changes into
[`@machize/permissions`](/guide/security).

## Setup

```ts
import { teamsPlugin, teamRoutes } from '@machize/teams'

const app = await createApp({
  plugins: [
    tenancyPlugin({ source, resolvers: [headerResolver()] }),
    authPlugin({ users, secret }),
    teamsPlugin(),
    fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes()] }),
  ],
}).boot()
```

The current tenant comes from `ctx().tenant` (set by tenancy) and the acting
user from `ctx().user` (set by auth).

## Roles

Roles are a ranked hierarchy — higher outranks lower:

| Role | Rank |
| --- | --- |
| `owner` | 3 |
| `admin` | 2 |
| `member` | 1 |

Override with `teamsPlugin({ roleRank: { owner: 3, billing: 2, member: 1 } })`.
A team always keeps at least one owner — the service refuses to demote or remove
the last one (`TEAM_LAST_OWNER`).

## Seeding the first owner

Invitations enroll members, but the first owner is seeded directly — typically
when the tenant is created:

```ts
import { TEAMS } from '@machize/teams'
await app.container.get(TEAMS).addMember(tenant.id, creator.id, 'owner')
```

## Routes

`teamRoutes()` registers, all scoped to the current tenant:

| Endpoint | Requires |
| --- | --- |
| `POST /team/invites` `{ email, role? }` | `admin` |
| `POST /team/invites/accept` `{ token }` | login |
| `GET /team/invites` · `DELETE /team/invites/:id` | `admin` |
| `GET /team/members` | `member` |
| `PATCH /team/members/:userId` `{ role }` | `admin` |
| `DELETE /team/members/:userId` | `admin` |

The `teamRole` guard enforces the required role: the current user must hold it —
or a higher-ranked role — in the current tenant.

```ts
route({ method: 'GET', url: '/reports', meta: { auth: true, teamRole: 'admin' }, handler: … })
```

## Invitations

`POST /team/invites` mints a one-time, expiring token (default 7 days) and emits
`team:invited` carrying it. **The token is emailed — never returned over HTTP.**
Wire the hook to your mailer:

```ts
hooks.on('team:invited', ({ invitation, token }) =>
  mailer.send(InviteEmail, { url: `${APP_URL}/invite?token=${token}` }, { to: invitation.email }))
```

A fresh invite for the same address supersedes any pending one. The full flow —
including email plumbing — is in the
[account lifecycle cookbook](/cookbook/account-lifecycle).

## Mirroring roles into permissions

Pass an `access` store (a `@machize/permissions` `AccessStore` satisfies the
structural `RoleAssigner`) and every membership change becomes a role grant in
that tenant's scope:

```ts
import { MemoryAccessStore } from '@machize/permissions'
const access = new MemoryAccessStore()
teamsPlugin({ access })
```

## Events

| Hook | Payload |
| --- | --- |
| `team:invited` | `{ invitation, token }` |
| `team:joined` | `{ membership }` |
| `team:role_changed` | `{ membership }` |
| `team:member_removed` | `{ tenantId, userId }` |
