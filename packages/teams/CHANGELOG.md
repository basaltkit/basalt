# @basaltkit/teams

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.4.2

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.4.1

### Patch Changes

- a76d591: `teamsPlugin` claims `'teamRole'` in the `http:guarded-meta` bucket so the adapters' new boot check knows `meta.teamRole` is enforced. No API or behavior change in this package itself.
- Updated dependencies [a76d591]
  - @basaltkit/http@1.12.0

## 1.4.0

### Minor Changes

- 6ca10e2: **`tenantMembershipPlugin` hardening: existence semantics by default, a WHO-based `exempt` escape, and an opt-in hook-invalidated decision cache.**
  
  **Semantics fix.** The guard's default was a rank check (`can(tenant, user, 'member')`): a genuine member holding a custom role absent from `roleRank` (rank 0 < member 1) was rejected with 403. A *membership* guard asks "does a membership record exist?" — that is now the default; rank semantics apply only with an explicit `role` option (pass `role: 'member'` to keep the old behavior verbatim). Behavior change is confined to unranked-custom-role members: 403 → pass, the intended meaning.
  
  **`exempt: (context) => boolean`.** Context-level escape for identities that legitimately cross tenants (platform admins, support): previously the only escape was route-level `meta.central`, which disables the guard for *everyone* on that route. The predicate is evaluated per request and never cached.
  
  **`cache: { ttlMs, maxEntries? }` (opt-in, off by default).** Without it every authenticated, tenant-scoped request costs one indexed membership lookup — usually fine, now documented honestly. With it, decisions are cached in-process and invalidated *immediately* by the `team:joined`/`team:role_changed`/`team:member_removed` hooks, so same-process changes are always exact; `ttlMs` bounds staleness only for changes made on another replica (a member removed elsewhere may retain access up to `ttlMs` — documented trade-off). The map is size-bounded (`maxEntries`, default 10 000, oldest evicted).
  
  Also added: an end-to-end regression test mounting the real `billingRoutes()` behind the guard — an authenticated user of tenant A forging `x-tenant-id: B` is a 403 (`TEAM_NOT_A_MEMBER`), closing the S-1 residual with adapter-level proof (plus a control test documenting the unguarded gap).

## 1.3.2

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 1.3.0

### Minor Changes

- Add `tenantMembershipPlugin` — a secure-by-default guard binding the authenticated user to the resolved tenant (403 for non-members).

## 1.2.0

### Minor Changes

- Security: **invite tokens are stored hashed.** The invitation token was persisted in plaintext, so a read of the invitations table let an attacker accept pending invites (bounded, since 1.1.0, by the invited-email check — but still a leak vector). Only `sha256(token)` is now stored and looked up; the raw token exists solely in the emailed link. Any invites issued before upgrading stop validating and must be re-sent.

## 1.1.0

### Minor Changes

- Security hardening (privilege escalation, invite binding):
  - **A member can no longer be granted a role above the actor's own.** `changeRole`, `invite` and `addMember` accept an `actingUserId` (threaded automatically by the HTTP routes from `ctx().user`). When set, the actor must rank at least as high as the role being granted and as high as the target's current role — so an admin can't mint, promote, or self-promote anyone to owner, nor re-role an owner. Server-side seeding without an actor is unchanged.
  - **Invite acceptance is bound to the invited email.** `accept(token, userId, acceptingEmail?)` now refuses (with the same `TeamInviteInvalidError`, to avoid confirming a valid token to the wrong recipient) when the caller's verified email doesn't match the invitation's — so a forwarded or leaked invite link can't enroll a different account. The HTTP route passes `ctx().user.email`.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/fastify@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/fastify@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/fastify@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/fastify@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/fastify@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/fastify@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/fastify@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/fastify@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/fastify@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/fastify@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/fastify@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/fastify@0.5.1
- @basaltkit/core@0.5.1

## 0.5.0

### Minor Changes

- b80bfb9: New package: `@basaltkit/teams` — multi-user tenants with roles and email invitations.

  - `Teams` service: `invite`, `accept`, `members`, `pendingInvites`, `changeRole`, `removeMember`, `addMember` (seed the first owner), `roleOf`, `can`. Ranked role hierarchy (`owner` > `admin` > `member`, overridable) with last-owner protection.
  - `teamsPlugin`: registers the service and a guard enforcing `meta.teamRole` on routes — the current `ctx().user` must hold that role or higher in the current `ctx().tenant`.
  - `teamRoutes()`: `POST /team/invites`, `POST /team/invites/accept`, `GET /team/invites`, `DELETE /team/invites/:id`, `GET /team/members`, `PATCH /team/members/:userId`, `DELETE /team/members/:userId`.
  - Invitation tokens are emailed out-of-band via the `team:invited` hook and never returned over HTTP. Also emits `team:joined`, `team:role_changed`, `team:member_removed`.
  - Optional `access` (a `RoleAssigner`, satisfied by a `@basaltkit/permissions` `AccessStore`) mirrors membership changes into role grants. Decoupled from auth/tenancy — identifiers are read from context.

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/fastify@0.5.0
