# @machize/teams

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@machize/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

### Patch Changes

- @machize/core@0.24.0
- @machize/fastify@0.24.0

## 0.23.0

### Patch Changes

- @machize/core@0.23.0
- @machize/fastify@0.23.0

## 0.22.0

### Patch Changes

- @machize/core@0.22.0
- @machize/fastify@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0
- @machize/fastify@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0
- @machize/fastify@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0
- @machize/fastify@0.19.0

## 0.18.0

### Patch Changes

- @machize/core@0.18.0
- @machize/fastify@0.18.0

## 0.17.0

### Patch Changes

- @machize/core@0.17.0
- @machize/fastify@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0
- @machize/fastify@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0
- @machize/fastify@0.15.0

## 0.14.0

### Patch Changes

- @machize/core@0.14.0
- @machize/fastify@0.14.0

## 0.13.0

### Patch Changes

- @machize/core@0.13.0
- @machize/fastify@0.13.0

## 0.12.0

### Patch Changes

- @machize/core@0.12.0
- @machize/fastify@0.12.0

## 0.11.0

### Patch Changes

- @machize/core@0.11.0
- @machize/fastify@0.11.0

## 0.10.0

### Patch Changes

- @machize/core@0.10.0
- @machize/fastify@0.10.0

## 0.9.0

### Patch Changes

- @machize/core@0.9.0
- @machize/fastify@0.9.0

## 0.8.1

### Patch Changes

- @machize/core@0.8.1
- @machize/fastify@0.8.1

## 0.8.0

### Patch Changes

- @machize/core@0.8.0
- @machize/fastify@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0
- @machize/fastify@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0
- @machize/fastify@0.6.0

## 0.5.1

### Patch Changes

- @machize/fastify@0.5.1
- @machize/core@0.5.1

## 0.5.0

### Minor Changes

- b80bfb9: New package: `@machize/teams` — multi-user tenants with roles and email invitations.

  - `Teams` service: `invite`, `accept`, `members`, `pendingInvites`, `changeRole`, `removeMember`, `addMember` (seed the first owner), `roleOf`, `can`. Ranked role hierarchy (`owner` > `admin` > `member`, overridable) with last-owner protection.
  - `teamsPlugin`: registers the service and a guard enforcing `meta.teamRole` on routes — the current `ctx().user` must hold that role or higher in the current `ctx().tenant`.
  - `teamRoutes()`: `POST /team/invites`, `POST /team/invites/accept`, `GET /team/invites`, `DELETE /team/invites/:id`, `GET /team/members`, `PATCH /team/members/:userId`, `DELETE /team/members/:userId`.
  - Invitation tokens are emailed out-of-band via the `team:invited` hook and never returned over HTTP. Also emits `team:joined`, `team:role_changed`, `team:member_removed`.
  - Optional `access` (a `RoleAssigner`, satisfied by a `@machize/permissions` `AccessStore`) mirrors membership changes into role grants. Decoupled from auth/tenancy — identifiers are read from context.

### Patch Changes

- @machize/core@0.5.0
- @machize/fastify@0.5.0
