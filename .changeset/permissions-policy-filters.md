---
'@basaltkit/permissions': minor
---

Policy list filters: `definePolicy(resource, checks, { filters })` declares the list form of a check next to it, and `gate.listFilter(user, 'resource:action')` returns `{ kind: 'unrestricted' | 'none' | 'where' }` for list and count queries. Fails closed with the new `MissingPolicyFilterError` (`PERMISSION_FILTER_MISSING`) when no filter matches, with no RBAC fallback; `superAdmin` short-circuits to `unrestricted` as in `can()`. Additive: `Policy` only gains an optional `filters` field. See RFC 0003.
