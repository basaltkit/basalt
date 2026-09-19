---
'@basaltkit/teams': major
'@basaltkit/teams-prisma': patch
'@basaltkit/teams-sqlite': patch
---

Security hardening (B03):

- `POST /team/invites/accept` now requires `ctx().user.emailVerified === true` (`403 TEAM_EMAIL_NOT_VERIFIED`) and refuses callers without an email. Previously, anyone who registered the invitee's address, or an identity with no email, could redeem a leaked link. Opt out explicitly with `teamRoutes({ requireVerifiedEmail: false })`.
- `removeMember` accepts `{ actingUserId }`, and `DELETE /team/members/:userId` passes it. An actor can remove only themselves or a member who does not outrank them, so an admin can no longer remove an owner.
- An acting user can no longer grant roles that are missing from `roleRank` (`403 TEAM_ROLE_NOT_GRANTABLE`) unless they are listed in the new `grantableRoles` option. `rankOf` ignores prototype keys.
- Invitation acceptance is a compare-and-set, so one token enrolls at most one account. `InvitationStore.markAccepted` may now resolve `boolean`, and the memory, SQLite and Prisma stores implement it atomically. The last-owner rule is re-checked after each write and rolled back on a lost race.
- The `tenantMembershipPlugin` decision cache no longer re-caches a decision that was invalidated while its lookup was in flight.
- Team routes fail closed when there is no acting user instead of falling back to the service's trusted mode.
