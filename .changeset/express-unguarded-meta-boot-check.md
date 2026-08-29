---
"@basaltkit/express": minor
---

**Advisory — boot now fails loud when a route declares security meta (`auth`, `can`, `teamRole`) that no registered guard enforces.**

Previously such a route silently served **unprotected**: `meta: { auth: true }` is inert metadata until `authPlugin` registers the guard that reads it, and nothing warned when it was missing. The adapter now calls `assertRoutesGuarded` (from `@basaltkit/http`) before registering routes and refuses to boot, listing every offending route and the plugin that enforces each key.

**If your app fails to boot after upgrading:** register the enforcing plugin (`auth` → `authPlugin`, `can` → `permissionsPlugin`, `teamRole` → `teamsPlugin`) — or, if protection genuinely happens at an outer edge/gateway, opt out explicitly with the new plugin option `allowUnguardedMeta: true` (or `['auth', …]` for specific keys). The default flips from silently-open to fail-loud on purpose: every app this breaks was serving routes it believed were protected.
