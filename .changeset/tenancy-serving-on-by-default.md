---
"@basaltkit/tenancy": minor
---

**`tenancy.run()` refuses a tenant that is not serving by default (#563).** `servingByDefault` is now `true`. `run(id, fn)` and the `'tenancy:run'` signal (queue workers, webhook deliveries) throw the HTTP enricher's errors for a provisioning, failed, deleting, suspended or unknown-status tenant: `TenantNotReadyError` 503, `TenantSuspendedError` 403, `TenantStatusUnknownError` 500. Before, only a request was checked, so a refresh by cookie, a job or a command could act for a suspended tenant. Lifecycle code enters on purpose with `{ serving: false }`, as `provision()`, `destroy()`, `forEach()` and the `tenant:*` commands already do.

**Breaking in a minor, by decision:** code that relied on entering a non-serving tenant (a back-office that opens suspended tenants, a restore) must pass `{ serving: false }`. `tenancyPlugin({ servingByDefault: false })` brings back the unchecked `run()` of 4.0–4.3 for the whole app.
