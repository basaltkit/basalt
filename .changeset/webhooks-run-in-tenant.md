---
'@basaltkit/webhooks': minor
---

The webhook outbox now works when endpoints live per tenant (a store over `tenantClient()` under schema- or database-per-tenant). Before this change every relayed entry failed with `DB_UNAVAILABLE` and dead-lettered.

- New `runInTenant` option on `WebhookManager` and `webhooksPlugin`. An off-request `dispatch()` scoped by an explicit `tenantId`, with no tenant in context, runs its endpoint lookup inside that tenant. Only the store read runs there: secrets are opened and deliveries sent after the run has ended, so a slow endpoint never holds the tenant's pooled database client. `webhooksPlugin` wires it automatically to `@basaltkit/tenancy`'s `'tenancy:run'` signal, resolved per dispatch so plugin order does not matter. This covers `webhookOutboxPlugin`, the `outboxPlugin({ dispatch: webhookOutboxDispatch(container.get(WEBHOOKS)) })` recipe, manual flushes and your own jobs. A tenant already in context still wins, and the runner is not called then.
- New `tenantOnly` option on `webhookOutboxPlugin`: capture only events emitted inside a tenant context. Set it when endpoints live per tenant.
- New exported type `TenantRunner`, declared structurally (no dependency on `@basaltkit/tenancy`).

Behaviour change — on by default. With `tenancyPlugin` registered, every dispatch scoped by an explicit `tenantId` outside a tenant context now runs its endpoint lookup inside `tenancy.run`, whatever the store's layout (shared schema and central webhook tables included). Per such dispatch:

- one `TenantSource.find` call. A transient failure of it (the tenant directory is unreachable) rejects the dispatch, and an outbox entry is retried like any failed delivery;
- `tenancy:switched` and `tenancy:exited` hooks fire, so every listener runs. Under schema- or database-per-tenant, `prismaPlugin` leases the tenant's pooled client for the duration of the lookup, even when the webhook store is central (a plain client) and never uses it: the lease can open or evict a pool slot, waits up to `acquireTimeoutMs` when the pool is saturated, and then fails with `PRISMA_POOL_EXHAUSTED`;
- a tenant that no longer exists rejects with `TENANT_NOT_FOUND`, and an id that fails the tenant-id grammar rejects with `TENANT_ID_INVALID`, both before any delivery. The outbox relay retries such an entry and dead-letters it after `maxAttempts` instead of delivering it.

Set `webhooksPlugin({ runInTenant: false })` when the webhook tables are central (shared schema, or a plain client under schema- or database-per-tenant). The lookup does not need the tenant there, and opting out removes the per-dispatch `find`, hooks and pool lease. A deleted tenant's endpoints then keep receiving deliveries until you remove them. Keep the default when endpoints live per tenant (`tenantClient()`).

The fix needs `@basaltkit/tenancy` with the `'tenancy:run'` signal (this release's minor). With an older tenancy, behaviour is unchanged. A `WebhookManager` you construct yourself gets no runner unless you pass `runInTenant`.
