<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/teams

Teams for Basalt applications: makes each tenant multi-user, with hierarchical roles (owner/admin/member), email invitations with acceptance and revocation, member management, and a route guard by team role.

You need this module when several people share the same account/organization — "invite a colleague to the workspace" is exactly this.

## What this module solves

In a SaaS, an organization (tenant) rarely has just one user: the founder invites colleagues, some are administrators and others just members. This module manages these **memberships** — who belongs to which team and with what **role** (the name of the person's "position" on the team, such as `owner`, `admin`, or `member`) — and **invitations**: the person receives an email with a link containing a **token** (single-use secret code), and upon accepting, joins the team with the role set in the invitation.

Roles are hierarchical by rank: by default `owner` (3) > `admin` (2) > `member` (1). Whoever has a higher-rank role can do everything a lower one can — a route that requires `admin` also accepts `owner`. There are built-in protections: a team can never end up without an owner (the last one can't be removed or demoted), invitation tokens expire (7 days by default), are single-use, and never appear in HTTP responses — only in the `team:invited` hook, for your application to send by email.

The module is deliberately decoupled: it receives `tenantId` and `userId` as strings, so it works with any authentication and tenancy setup. Optionally, it mirrors team roles into `@basaltkit/permissions`, so that "admin of team acme" automatically translates into permissions.

## Installation

```bash
pnpm add @basaltkit/teams
```

## Get started in 5 minutes

1. **Just the logic (no HTTP)** — create the team, invite, and accept:

```ts
import { Teams } from '@basaltkit/teams'

const teams = new Teams() // in-memory stores by default

// The first owner is added directly (e.g. when creating the tenant)
await teams.addMember('acme', 'user-ada', 'owner')

// Invite Bob as a member — the token goes in the email link
const { invitation, token } = await teams.invite({
  tenantId: 'acme',
  email: 'bob@example.com',
  role: 'member',
  invitedBy: 'user-ada',
})

// Bob (already authenticated as user-bob) accepts with the token from the link
const membership = await teams.accept(token, 'user-bob')
console.log(membership) // { tenantId: 'acme', userId: 'user-bob', role: 'member', createdAt: ... }

console.log(await teams.roleOf('acme', 'user-bob')) // 'member'
console.log(await teams.can('acme', 'user-bob', 'admin')) // false — member < admin
```

2. **Complete HTTP application** with auth + tenancy + ready-made team routes:

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
      resolvers: [headerResolver()],
    }),
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    teamsPlugin(),
    fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes()] }),
  ],
}).boot()

// Send the invitation email when it's created
app.hooks.on('team:invited', async ({ invitation, token }) => {
  await sendEmail(invitation.email, `https://app.example.com/invite?token=${token}`)
})

// Seed the first owner when creating the organization
const teams = app.container.get(TEAMS)
await teams.addMember('acme', 'ada-id', 'owner')
```

3. From here, HTTP requests (with `Authorization: Bearer <login token>` and `x-tenant-id: acme`) use the ready-made routes: `POST /team/invites`, `POST /team/invites/accept`, `GET /team/members`, etc.

## Usage guide

### Invitations

- `invite({ tenantId, email, role?, invitedBy? })` creates (or replaces) the invitation — **one pending invitation per email per team**; a new one revokes the previous. Default role: `'member'`. Validity: `inviteTtl` (default `'7d'`).
- Returns `{ invitation, token }` — `invitation` is `PublicInvitation` (without the token) and `token` is used to build the link. The `team:invited` hook receives the same pair.
- `accept(token, userId)` consumes the token (single use) and enrolls the user with the invitation's role. Unknown, used, revoked, or expired token → `TeamInviteInvalidError` (400).
- `pendingInvites(tenantId)` lists non-expired pending invites; `revokeInvite(id)` cancels one; `invitation(id)` looks one up.

### Members and roles

```ts
import { Teams } from '@basaltkit/teams'

const teams = new Teams()
await teams.addMember('acme', 'u1', 'owner')

await teams.members('acme')                 // list of Membership
await teams.roleOf('acme', 'u1')            // 'owner' (or null if not a member)
await teams.can('acme', 'u1', 'admin')      // true — owner (3) >= admin (2)
await teams.changeRole('acme', 'u2', 'admin')
await teams.removeMember('acme', 'u2')
```

Last-owner protection: `changeRole` and `removeMember` throw `LastOwnerError` (400) if they would leave the team without any `owner`.

### Custom role hierarchy

Roles are free-form strings; the hierarchy is a name → rank map (roles outside the map have rank 0):

```ts
import { Teams } from '@basaltkit/teams'

const teams = new Teams({
  roleRank: { owner: 4, admin: 3, editor: 2, viewer: 1 },
})
```

### Protecting routes by role (`meta.teamRole`)

`teamsPlugin` registers a guard: routes with `meta: { teamRole: 'admin' }` require the current user (`ctx().user`, from auth) to have that role **or higher** in the current tenant (`ctx().tenant`, from tenancy):

```ts
import { route } from '@basaltkit/fastify'

const myRoute = route({
  method: 'POST',
  url: '/projects',
  meta: { auth: true, teamRole: 'admin' }, // member → 403 TEAM_ROLE_REQUIRED
  async handler() { return { created: true } },
})
```

No tenant or no user in context → `NotATeamMemberError` (403).

### Mirroring roles into @basaltkit/permissions

Pass a `RoleAssigner` (any object with `assignRole`/`removeRole` — an `AccessStore` from permissions works) and every team join/change/leave is mirrored as a role in the tenant's scope:

```ts
import { Teams } from '@basaltkit/teams'
import { MemoryAccessStore } from '@basaltkit/permissions'

const access = new MemoryAccessStore()
const teams = new Teams({ access })

await teams.addMember('acme', 'u1', 'admin')
// → access.assignRole('u1', 'admin', 'acme') was called automatically
```

### Hooks (events)

| Hook | Payload | When |
|---|---|---|
| `team:invited` | `{ invitation, token }` | Invitation created — send the email here. |
| `team:joined` | `{ membership }` | Someone joined (accept or addMember). |
| `team:role_changed` | `{ membership }` | Role changed. |
| `team:member_removed` | `{ tenantId, userId }` | Member removed. |

## API reference

### `teamsPlugin(options)` and the `Teams` class

Options (`TeamsOptions`; `TeamsPluginOptions` is the same minus `hooks`) — all optional:

| Name | Type | Default | Description |
|---|---|---|---|
| `memberships` | `MembershipStore` | `MemoryMembershipStore` | Where memberships live. |
| `invitations` | `InvitationStore` | `MemoryInvitationStore` | Where invitations live. |
| `access` | `RoleAssigner` | — | Mirrors roles (e.g. permissions' AccessStore). |
| `inviteTtl` | `DurationInput` | `'7d'` | Invitation link validity. |
| `roleRank` | `Record<string, number>` | `{ owner: 3, admin: 2, member: 1 }` | Role hierarchy. |
| `now` | `() => number` | `Date.now` | Injectable clock (tests). |
| `hooks` | `HookBus` | — | Class only; the plugin injects it. |

`Teams` methods:

| Method | Returns | Description |
|---|---|---|
| `addMember(tenantId, userId, role)` | `Promise<Membership>` | Adds/updates directly (seed the first owner). |
| `invite(input)` | `Promise<{ invitation, token }>` | Creates/replaces the invitation; emits `team:invited`. |
| `accept(token, userId)` | `Promise<Membership>` | Consumes the token and enrolls the user. |
| `members(tenantId)` | `Promise<Membership[]>` | Lists the members. |
| `pendingInvites(tenantId)` | `Promise<PublicInvitation[]>` | Non-expired pending invitations. |
| `invitation(id)` | `Promise<PublicInvitation \| null>` | One invitation (without the token). |
| `revokeInvite(id)` | `Promise<void>` | Cancels a pending invitation. |
| `roleOf(tenantId, userId)` | `Promise<TeamRole \| null>` | User's role (or null). |
| `can(tenantId, userId, required)` | `Promise<boolean>` | Has the required role or higher? |
| `changeRole(tenantId, userId, role)` | `Promise<Membership>` | Changes the role; protects the last owner. |
| `removeMember(tenantId, userId)` | `Promise<void>` | Removes; protects the last owner. |
| `rankOf(role)` | `number` | Rank of the role (0 if unknown). |

### Ready-made routes — `teamRoutes()`

All require login (`meta.auth`); the marked ones also require a team role. The tenant comes from `ctx().tenant` (without it → 400 `TEAM_NO_TENANT`).

| Route | Minimum role | Description |
|---|---|---|
| `POST /team/invites` `{ email, role? }` | admin | Creates the invitation (201; the token never appears in the response). |
| `POST /team/invites/accept` `{ token }` | (login only) | Accepts the invitation. |
| `GET /team/invites` | admin | Lists pending invitations. |
| `DELETE /team/invites/:id` | admin | Revokes it (404 if from another tenant). |
| `GET /team/members` | member | Lists members. |
| `PATCH /team/members/:userId` `{ role }` | admin | Changes the role. |
| `DELETE /team/members/:userId` | admin | Removes the member. |

### Types, stores, and constants

| Export | Description |
|---|---|
| `TeamRole` | `string` — free-form role name. |
| `Membership` | `{ tenantId, userId, role, createdAt }`. |
| `Invitation` / `PublicInvitation` | Invitation with/without the `token` field. |
| `MembershipStore` / `InvitationStore` | Interfaces for you to implement over your DB. |
| `MemoryMembershipStore` / `MemoryInvitationStore` | In-memory implementations (dev/testing). |
| `RoleAssigner` | `{ assignRole(userId, role, scope), removeRole(...) }`. |
| `DEFAULT_ROLE_RANK` | `{ owner: 3, admin: 2, member: 1 }`. |
| `OWNER` | The string `'owner'`. |
| `TEAMS` | Injection token: `container.get(TEAMS)` → `Teams`. |

### Errors

| Error | Code | HTTP |
|---|---|---|
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 |

## Common issues and solutions (FAQ)

**"The invitation is created but no one gets an email."** The module doesn't send emails — it emits the `team:invited` hook with `{ invitation, token }`; your application listens to it and sends the link.

**"400 TEAM_INVITE_INVALID when accepting."** The token has already been used (it's single-use), has expired (`inviteTtl`, 7 days), was revoked, or was replaced by a newer invitation for the same email.

**"403 TEAM_NOT_A_MEMBER on a route with teamRole."** The guard needs both `ctx().user` **and** `ctx().tenant`. Confirm that auth and tenancy are registered and that the request carries credentials and a tenant identifier (e.g. the `x-tenant-id` header in dev).

**"400 TEAM_LAST_OWNER when removing/demoting someone."** This is the last-owner protection. Promote someone else to `owner` first.

**"How do I create the first team?"** When creating the tenant, call `teams.addMember(tenantId, userId, 'owner')` directly — invitations are for the ones that follow.

**"Members disappear on restart."** In-memory stores. Implement `MembershipStore` and `InvitationStore` over your database (you can store just the hash of the invitation token, as the comment on the `Invitation` type suggests).

## How it connects to other modules

- **@basaltkit/tenancy** — the team IS the set of users of a tenant; routes and the guard read `ctx().tenant.id`.
- **@basaltkit/auth** — identifies who's making the request (`ctx().user.id`), used by the `teamRole` guard and by `accept`.
- **@basaltkit/permissions** — via the `access` option (`RoleAssigner`), team roles become roles in the tenant's scope, gaining whatever permissions you define for them in the Gate.
- **@basaltkit/core / @basaltkit/fastify** — container, context, hooks, and execution of guards and routes.
