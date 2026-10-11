---
'@basaltkit/http': major
---

An invalid `meta.responseHeaders` refuses the boot again.

`assertRouteMetaValid` (which every adapter runs at boot through `assertRoutesGuarded`) checks `meta.responseHeaders` itself, whether or not any plugin registered a route-meta validator: a record that is not an object of string values, carries a CR/LF/NUL or other control character, or sets `set-cookie`, `content-type`, `content-length`, `transfer-encoding`, a hop-by-hop header or `x-request-id` refuses the boot with `HTTP_INVALID_ROUTE_META`, naming each route, on fastify, express and hono. 2.8 printed one boot warning and silently sent none of the record's headers.

`applyRouteHeaders` (the shared pipeline) now throws the newly exported `InvalidRouteHeadersError` (`HTTP_INVALID_ROUTE_HEADERS`, 500) on every request for a record that skipped the boot check — a bespoke `runRoute` driver that never called `assertRouteMetaValid` — before setting any of its headers.

`meta.headers` is still app-owned data: never read, validated or sent.

**Migrating.** If 2.8 printed `[basalt] invalid meta.responseHeaders …`, fix or remove the record it named: set a cookie with `reply.header()` in the handler, let the payload decide its `content-type`, and keep values free of line breaks. A bespoke driver should call `assertRouteMetaValid(routes, container)` once at startup.
