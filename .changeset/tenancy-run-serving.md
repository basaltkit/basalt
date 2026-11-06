---
"@basaltkit/tenancy": minor
---

`tenancy.run(tenantOrId, fn, { serving: true })` refuses a tenant that cannot serve with the HTTP enricher's errors (`TenantNotReadyError` 503, `TenantSuspendedError` 403, `TenantStatusUnknownError` 500), before entering the context or firing any hook (BK-018). Use it for work done for a tenant outside a request — a refresh by cookie, a job, a command. The default is unchanged (`run()` still enters any tenant, as provisioning needs).
