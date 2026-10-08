---
'@basaltkit/teams': minor
---

Accept an invitation once the invited address is proven, and gate signups on tenant hosts (BK-033, BK-044).

- `teams.acceptByEmail({ tenantId, userId, email, emailVerified })` accepts the pending invitation of ONE tenant for a verified address, with the same guarantees as `accept()` (live invitation only, canonical address match, compare-and-set, never demotes). Returns `[]` unless `emailVerified === true`.
- `teamsPlugin({ acceptOnVerifiedEmail: true })` (default `false`) runs it on `auth:email_verified` and `auth:login` for the current `ctx().tenant` (nothing on the apex). It never fails the login: errors go to the new `team:auto_accept_failed` hook.
- `teams.pendingInviteFor(tenantId, email)` returns the live invitation for an address, read-only.
- `teamsInviteGate(teams | () => teams)` is a ready-made `@basaltkit/auth` `RegisterPolicy`: apex open, tenant hosts invite-only.
