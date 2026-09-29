---
'@basaltkit/tenancy': minor
---

Tenant status: a suspended tenant is 403, an unknown status fails closed with an accurate error, and `new Tenancy()` takes an options object (FRAMEWORK-AUDIT "Melhorias" 4).

The request enricher used to answer every status other than `ready` with 503 `TENANT_NOT_READY` "still being provisioned" — including `suspended` (so clients retried a locked-out account) and values tenancy does not know, such as `active` (with a message that was simply false). It now runs the new `assertTenantServing(tenant)`:

| `status` | Before | Now |
| --- | --- | --- |
| absent / `ready` | serves | serves |
| `null` | 503 "still being provisioned" | serves — a nullable status column's "no status", same as absent |
| `provisioning` / `failed` / `deleting` | 503 `TENANT_NOT_READY` | unchanged |
| `suspended` | 503 `TENANT_NOT_READY` | **403 `TENANT_SUSPENDED`** (`TenantSuspendedError`) |
| anything else (`active`, `disabled`, …) | 503 `TENANT_NOT_READY` | **500 `TENANT_STATUS_UNKNOWN`** (`TenantStatusUnknownError`), naming the value it saw |

Every tenant that was refused is still refused; only the status code and error code now say why. `'suspended'` joins the `TenantStatus` union (tenancy never writes it — the app does), and `TENANT_STATUSES` lists the known values. If your records use `active` for a serving tenant, store `ready` (or no status) instead — that was already required, it is now reported as such. A client that retried on 503 for a suspended tenant now receives a non-retryable 403.

`new Tenancy({ source, resolvers, hooks?, onProvision?, provisionMode?, onDeprovision?, canonicalDomain?, validateTenantId?, onConflict? })` — the new `TenancyOptions` object. The nine-argument positional form still works. The README documented a three-argument constructor and a `where.tenantId` fallback in `tenantScoped()` that the code (correctly) never had; both are fixed.
