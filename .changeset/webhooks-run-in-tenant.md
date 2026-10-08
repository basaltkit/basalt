---
'@basaltkit/webhooks': minor
---

The webhook outbox now works when endpoints live per tenant (a store over `tenantClient()` under schema- or database-per-tenant). Before this change every relayed entry failed with `DB_UNAVAILABLE` and dead-lettered.

- New `runInTenant` option on `WebhookManager` and `webhooksPlugin`. An off-request `dispatch()` scoped by an explicit `tenantId`, with no tenant in context, runs its endpoint lookup inside that tenant. Only the store read runs there: secrets are opened and deliveries sent after the run has ended, so a slow endpoint never holds the tenant's pooled database client. `webhooksPlugin` wires it automatically to `@basaltkit/tenancy`'s `'tenancy:run'` signal, resolved per dispatch so plugin order does not matter. This covers `webhookOutboxPlugin`, the `outboxPlugin({ dispatch: webhookOutboxDispatch(container.get(WEBHOOKS)) })` recipe, manual flushes and your own jobs. A tenant already in context still wins, and the runner is not called then.
- New `tenantOnly` option on `webhookOutboxPlugin`: capture only events emitted inside a tenant context. Set it when endpoints live per tenant.
- New exported type `TenantRunner`, declared structurally (no dependency on `@basaltkit/tenancy`).

Behaviour notes. With `tenancyPlugin` registered, every dispatch scoped by an explicit `tenantId` outside a tenant context now runs its lookup inside `tenancy.run`. That applies to shared-schema apps too:

- one `TenantSource.find` per such dispatch;
- `tenancy:switched` and `tenancy:exited` hooks fire per such dispatch;
- a dispatch for a tenant that no longer exists rejects with `TENANT_NOT_FOUND` before any delivery, so its outbox entries dead-letter instead of being delivered.

Opt out with `webhooksPlugin({ runInTenant: false })`. The fix needs `@basaltkit/tenancy` with the `'tenancy:run'` signal (this release's minor). With an older tenancy, behaviour is unchanged. A `WebhookManager` you construct yourself gets no runner unless you pass `runInTenant`.
