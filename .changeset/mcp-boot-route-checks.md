---
'@basaltkit/mcp': major
---

`mcpPlugin` runs the adapters' boot checks over the routes it exposes as tools.

A route reachable only through MCP (passed to `mcpPlugin({ routes })` but not to the adapter) used to get no boot check at all: an unknown `meta.tenant` (for example `'none'`, a typo of `'never'`), an invalid `meta.responseHeaders` or security meta no registered guard enforces (`meta.auth` without `authPlugin`) were accepted. `mcpPlugin` now calls `assertRoutesGuarded(routes, container)` at boot on every route it turns into a tool (opted in with `meta.mcp` and kept by `filter`), which runs every plugin's `http:meta-validators` entry, so the boot fails with `HTTP_INVALID_ROUTE_META` or `HTTP_UNGUARDED_ROUTE_META` exactly as on fastify, express and hono.

`filter` is evaluated once and the server exposes that same list, so a filter that is not a pure function of the route can no longer expose a tool the boot checks never saw.

New option `allowUnguardedMeta` (same meaning as the adapter option) waives the unguarded-meta check when an outer edge enforces it. It never waives the meta validators.

**Migrating.** If the boot now fails, fix the route it names, or pass `mcpPlugin({ routes, allowUnguardedMeta: [...] })` with the same waiver your adapter uses. Code that builds `new McpServer({ routes, container })` directly gets no check: call `assertRoutesGuarded(routes, app.container)` after boot.
