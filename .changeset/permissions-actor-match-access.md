---
'@basaltkit/permissions': patch
---

Add `gate.actor()`, a browser-safe `/match` subpath, and `accessRoutes()`.

**`gate.actor()`** returns the current user with its roles attached. What
`@basaltkit/auth` puts in the context is `PublicUser` — `{ id, email,
emailVerified }` — with no roles, rightly, since `auth` does not know this
package exists. But policies receive that object, so `user.roles?.includes(…)`
read `undefined` and the policy denied: the right failure mode and an invisible
one, a partner treated as a stranger in their own firm with no error anywhere.

Nothing filled the gap, so every service hydrated by hand and memoised under a
private context key it had to invent. This memoises per request *and per scope* —
the same person can hold different roles in two tenants — and returns `null`
when there is no user, rather than an actor that fails every check for a reason
nobody can read.

**`@basaltkit/permissions/match`** exports `permissionMatches` and `permitted`
and imports nothing. The rule was already implemented and unreachable from a
browser: the package has a single entry point and depends on `@basaltkit/core`,
which imports `node:async_hooks`. So frontends rewrote it, and the rewrites
drifted — one handled `resource:*` and missed the global `'*'`, hiding controls
from the people allowed to use them.

**`accessRoutes()`** serves `GET /me/access` with `{ roles, permissions }`,
merging direct grants with everything each role carries. `/auth/me` answers who
you are; nothing answered what you may do, so every frontend wrote the same
twenty lines. Not a security surface — the server still decides on every
request — but a UI that stops offering doors returning 403.

It deliberately has no `meta.auth`: a public page asks before anyone logs in,
and empty is the honest answer there.
