---
'@basaltkit/tenancy': minor
---

`tenancyPlugin({ servingByDefault: true })` (also `new Tenancy({ servingByDefault })`) makes every `tenancy.run()` refuse a tenant that is not serving, with the enricher's errors (`TenantNotReadyError` 503, `TenantSuspendedError` 403, `TenantStatusUnknownError` 500), unless the caller passes `{ serving: false }`. The `'tenancy:run'` signal used by queue workers and webhook deliveries follows it. The framework's lifecycle paths (`provision()`, `destroy()`, `forEach()`, `tenant:migrate`, `tenant:seed`, `tenant:run`) now enter with `{ serving: false }` explicitly, so they keep reaching every tenant. Default `false`: nothing changes until an app turns it on. It becomes the default in the next major (BK-018, #563).
