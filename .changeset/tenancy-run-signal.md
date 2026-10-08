---
'@basaltkit/tenancy': minor
---

`tenancyPlugin` publishes a `'tenancy:run'` metadata signal next to `'tenancy:active'`, and the package exports its type, `TenantRunner` (`<T>(tenantId, fn) => Promise<T>`). The signal is exactly `tenancy.run(tenantId, fn)`, so background code in other packages can enter a tenant the official way without importing `TENANCY`: the id grammar is checked (`InvalidTenantIdError`), the `TenantSource` lookup runs (`TenantNotFoundError`), and `tenancy:switched` (`via: 'run'`) and `tenancy:exited` fire around `fn`, which makes `prismaPlugin` lease and release the tenant's client. The tenant's `status` is not checked. It runs from the caller's context, so start from `runWithContext({}, ...)` when ambient state must not leak in. `@basaltkit/webhooks` is the first consumer.
