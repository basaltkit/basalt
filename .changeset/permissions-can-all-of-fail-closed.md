---
"@basaltkit/permissions": minor
---

**Security: `meta.can` now supports `string[]` (all-of) and fails CLOSED on unenforceable shapes.**

The guard used to silently skip the permission check for any non-string `meta.can` — `can: ['billing:manage']` or `can: true` type-checked (route meta is `Record<string, unknown>`) and the route served with **no authorization at all**, only the auth check. Now:

- `can: 'projects:delete'` — unchanged.
- `can: ['reports:read', 'reports:export']` — NEW: requires **all** listed permissions (the natural reading; the sibling API-key guard already uses an array for `meta.scopes`).
- Anything else (`true`, a number, an empty or mixed array) throws the new `InvalidCanMetaError` (`PERMISSION_META_INVALID`, HTTP 500) on every request to that route — an unenforceable authorization declaration must fail loud, never fail open.

The plugin also claims `'can'` in the new `http:guarded-meta` bucket, so the adapters' boot check can reject routes that declare `meta.can` when `permissionsPlugin` is not registered (see the `@basaltkit/http` release).

**Behavior change:** a route that previously declared a malformed `meta.can` was silently unprotected; it now errors. That is the fix.
