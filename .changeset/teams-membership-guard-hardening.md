---
"@basaltkit/teams": minor
---

**`tenantMembershipPlugin` hardening: existence semantics by default, a WHO-based `exempt` escape, and an opt-in hook-invalidated decision cache.**

**Semantics fix.** The guard's default was a rank check (`can(tenant, user, 'member')`): a genuine member holding a custom role absent from `roleRank` (rank 0 < member 1) was rejected with 403. A *membership* guard asks "does a membership record exist?" — that is now the default; rank semantics apply only with an explicit `role` option (pass `role: 'member'` to keep the old behavior verbatim). Behavior change is confined to unranked-custom-role members: 403 → pass, the intended meaning.

**`exempt: (context) => boolean`.** Context-level escape for identities that legitimately cross tenants (platform admins, support): previously the only escape was route-level `meta.central`, which disables the guard for *everyone* on that route. The predicate is evaluated per request and never cached.

**`cache: { ttlMs, maxEntries? }` (opt-in, off by default).** Without it every authenticated, tenant-scoped request costs one indexed membership lookup — usually fine, now documented honestly. With it, decisions are cached in-process and invalidated *immediately* by the `team:joined`/`team:role_changed`/`team:member_removed` hooks, so same-process changes are always exact; `ttlMs` bounds staleness only for changes made on another replica (a member removed elsewhere may retain access up to `ttlMs` — documented trade-off). The map is size-bounded (`maxEntries`, default 10 000, oldest evicted).

Also added: an end-to-end regression test mounting the real `billingRoutes()` behind the guard — an authenticated user of tenant A forging `x-tenant-id: B` is a 403 (`TEAM_NOT_A_MEMBER`), closing the S-1 residual with adapter-level proof (plus a control test documenting the unguarded gap).
