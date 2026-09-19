---
'@basaltkit/webhooks': minor
'@basaltkit/events': minor
---

Security hardening for webhooks and the outbox:

- webhooks: a dispatch with no tenant now reaches only tenant-agnostic endpoints (explicit `{ allTenants: true }` for system fan-out); with tenancy active, `register`/`list`/`unregister` without a tenant throw `WebhookTenantRequiredError` unless `{ system: true }`; `list()` no longer returns signing secrets (`hasSecret` instead).
- webhooks: the SSRF guard now classifies IPv6 addresses over their parsed bytes, so IPv4-mapped/compatible, NAT64, 6to4 and other special-purpose forms of private addresses are refused.
- webhooks: tenant endpoints get their own generated signing secret (returned once by `register()`); tenant endpoints are never signed with the plugin-wide secret and deliveries are never sent unsigned by default (`allowSharedSecret` / `allowUnsigned` opt-outs); secrets under 16 characters are refused and `verifySignature` returns `false` for them; each delivery carries a signed unique `id` (`x-basalt-delivery`) and `endpointId`.
- webhooks: delivery closes the connection once the response status is known instead of draining the body.
- events: `Outbox` no longer lets entries in backoff occupy the batch, dispatches a batch with bounded parallelism (`concurrency`, default 8), and `MemoryOutboxStore` prunes old published entries (`retainPublished`, default 1000). `webhookOutboxPlugin` forwards `concurrency`.
