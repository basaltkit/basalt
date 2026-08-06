---
'@machize/teams': minor
---

New package: `@machize/teams` — multi-user tenants with roles and email invitations.

- `Teams` service: `invite`, `accept`, `members`, `pendingInvites`, `changeRole`, `removeMember`, `addMember` (seed the first owner), `roleOf`, `can`. Ranked role hierarchy (`owner` > `admin` > `member`, overridable) with last-owner protection.
- `teamsPlugin`: registers the service and a guard enforcing `meta.teamRole` on routes — the current `ctx().user` must hold that role or higher in the current `ctx().tenant`.
- `teamRoutes()`: `POST /team/invites`, `POST /team/invites/accept`, `GET /team/invites`, `DELETE /team/invites/:id`, `GET /team/members`, `PATCH /team/members/:userId`, `DELETE /team/members/:userId`.
- Invitation tokens are emailed out-of-band via the `team:invited` hook and never returned over HTTP. Also emits `team:joined`, `team:role_changed`, `team:member_removed`.
- Optional `access` (a `RoleAssigner`, satisfied by a `@machize/permissions` `AccessStore`) mirrors membership changes into role grants. Decoupled from auth/tenancy — identifiers are read from context.
