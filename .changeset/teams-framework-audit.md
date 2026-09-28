---
'@basaltkit/teams': major
---

Security fixes from the framework audit (FA-044, FA-045, FA-071 T-2/T-6/T-7).

- **An unknown or typo'd role never admits (FA-044).** A role outside `roleRank` used to rank 0, so `meta.teamRole: 'Admin'` (or `'adimn'`) — and `can(t, u, 'Admin')` — admitted every member. Now:
  - The `meta.teamRole` guard requires a **known** role (ranked in `roleRank` or listed in `grantableRoles`, see the new `teams.isKnownRole()`); anything else fails closed with the new `UnknownTeamRoleError` (`TEAM_ROLE_UNKNOWN`, 500). The same check applies to `tenantMembershipPlugin({ role })`.
  - `can()` only climbs the hierarchy for a **ranked** required role, and only a member holding a ranked role can satisfy it. An unranked required role is matched **exactly** (the rule `roleRecipients` already used). An empty or non-string required role is `false`.
- **`meta.teamRole: ''` no longer disables the guard (T-2).** Only `undefined` and `false` mean "no requirement" — the same rule the adapters' boot check uses; `''`, `null` or a non-string is `TEAM_ROLE_UNKNOWN`.
- **"One pending invite per email" is case-insensitive (FA-045).** `invite()` stores the address in canonical form (new `canonicalInviteEmail()`: trimmed and lower-cased, the folding `@basaltkit/auth` uses) and supersedes **every** pending invitation for that address — including mixed-case rows written by earlier versions — so an old `admin` invite to `Bob@x` no longer survives a later `member` invite to `bob@x`. `accept()` compares canonical forms. No NFKC folding (T-4, declined): it would merge distinct mailboxes and let an invite bind to an account it wasn't sent to.
- **Memory stores:** `MemoryMembershipStore` keys can no longer collide across the tenant/user boundary (`'a::b'`+`'c'` vs `'a'`+`'b::c'`, T-6), and both memory stores copy records in and out, so mutating a returned object (e.g. the membership `addMember()` returns) no longer rewrites the store (T-7).

**Migration.**
- Fix any `meta.teamRole` / `tenantMembershipPlugin({ role })` value that is not in `roleRank` or `grantableRoles` — those routes now answer 500 instead of admitting everyone.
- If you relied on an unranked role in `meta.teamRole` (e.g. `teamRole: 'viewer'` from `grantableRoles`) admitting all members, it now admits only holders of exactly that role. Rank the role (add it to `roleRank`) if you want hierarchy semantics.
- A member holding an unranked role no longer satisfies a ranked role of rank 0 (e.g. `roleRank: { guest: 0 }`).
- Invitation emails are now returned (`PublicInvitation.email`, the `team:invited` hook) in lower case. No data migration is needed: supersession compares canonical forms on both sides.
