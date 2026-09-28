---
'@basaltkit/permissions': minor
---

`permissionsPlugin` registers an `http:route-visibility` check for `meta.can` (framework audit FA-035 residual), so listings such as `@basaltkit/mcp`'s `tools/list` hide routes whose permission(s) the caller lacks.

The check asks the guard's own question — `gate.can(user, permission)` for every entry (all-of), in the current scope, `superAdmin` short-circuiting — through a path with no side effects: `can()` without a resource only reads grants and never emits `permission:denied`, so listings stay out of the audit trail. No user or an unenforceable `meta.can` hides the route (the guard would refuse it). Policies never decide `meta.can` (the guard passes no resource), so a resource-level `authorize()` inside a handler is invisible to listings: such a route stays listed and is refused on the call. Visibility is never authorization — every call still runs the guard. Keep a `superAdmin` callback pure; listings consult it too.
