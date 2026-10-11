---
'@basaltkit/http': major
---

Enrichers that cannot run fail closed, like guards.

`runRoute()` ran the request enrichers only when the pipeline carried a `container`; a hand-built pipeline that passed `enrichers` but no `container` dropped them silently and ran the handler with no tenant and no user resolved (tenancy's per-request refusal of an unknown `meta.tenant` included). It now throws the newly exported `EnrichersWithoutContainerError` (`HTTP_ENRICHERS_UNRUNNABLE`, 500) naming the route and the number of enrichers, before any of them or the handler runs — the rule `GuardsWithoutContainerError` already applied to guards.

Every shipped adapter (fastify, express, hono) and `mcpPlugin` pass the container, so nothing changes for them. A pipeline with no enrichers, no guards and no container still runs.

**Migrating.** A bespoke driver that passes `enrichers` must also pass `container` (the app's container, as the adapters do).
