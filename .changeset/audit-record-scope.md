---
'@basaltkit/audit': minor
---

`audit.record(event, payload, scope?)` accepts an optional `{ tenantId?, actorId? }` scope to attribute a manual entry recorded outside a request (scripts, CLI commands). The entry joins that tenant's hash chain. The scope can only narrow: inside a context with a tenant or user, a different value throws a `TypeError`. Without `scope` the behaviour is unchanged.
