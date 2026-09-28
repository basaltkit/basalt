---
'@basaltkit/teams': major
---

An unknown `meta.teamRole` now fails the **boot**, not the first request (framework audit FA-044 residual).

- `teamsPlugin` registers a route-meta validator (`http:meta-validators`): a route whose `meta.teamRole` is not a known role (ranked in `roleRank` or listed in `grantableRoles`) — a typo like `'Admin'`, `''`, a number, `null` — makes every adapter refuse to boot with `InvalidRouteMetaError`, naming the route and the value. `allowUnguardedMeta` does not waive it. The runtime check stays: a route mounted outside the adapter's list (or run through `runRoute()` directly) still answers `TEAM_ROLE_UNKNOWN` (500).
- `tenantMembershipPlugin({ role })` with an unknown role now throws `UnknownTeamRoleError` at boot (when `teamsPlugin` is registered), instead of 500-ing every tenant-scoped request.
- `teamsPlugin` also registers a pure visibility check (`http:route-visibility`) for `meta.teamRole`: listing surfaces such as `@basaltkit/mcp`'s `tools/list` hide a teamRole route from callers who do not hold the role in the current tenant (a membership read — no hooks, no writes).

**Migration.** An app that booted with a typo'd `meta.teamRole` (answering 500 on those routes since the FA-044 fix) now fails to start — fix the role, or rank it in `roleRank`.
