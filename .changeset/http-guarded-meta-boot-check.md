---
"@basaltkit/http": minor
---

**New: `assertRoutesGuarded` + the `http:guarded-meta` claims bucket — security route-meta must be enforced or the app refuses to boot.**

`meta.auth` / `meta.can` / `meta.teamRole` are *requests* for protection; the guard a plugin registers is what enforces them. A route declaring one of these in an app that never registered the enforcing plugin used to serve **unprotected with zero signal** (verified live: a `meta: { auth: true }` page returned 200 in an app without `authPlugin`).

- `GUARDED_META_KEYS` — the security-relevant keys the framework knows (`auth`, `can`, `teamRole`).
- `GUARDED_META_BUCKET` (`'http:guarded-meta'`) — enforcing plugins claim the key(s) their guards consume (auth → `'auth'`, permissions → `'can'`, teams → `'teamRole'`). String-keyed metadata — no package coupling. Custom guard plugins that enforce one of these keys should claim it the same way.
- `assertRoutesGuarded(routes, claimed, allow?)` — throws the new `UnguardedRouteMetaError` listing every offending `METHOD url → key` in one aggregate error. Called by the Fastify/Express/Hono adapters at boot.

`meta.auth: false` / `undefined` are explicit opt-offs, never flagged; non-security meta keys (`rateLimit`, `central`, …) are never flagged.
