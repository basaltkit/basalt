---
'@basaltkit/tenancy': minor
'@basaltkit/tenancy-prisma': minor
'@basaltkit/tenancy-sqlite': minor
---

`tenancy.create()` refuses a tenant id that already exists with the new `TenantAlreadyExistsError` (`TENANT_ALREADY_EXISTS`, HTTP 409): nothing is written, no hook fires and `onProvision` does not run. When the existing tenant is `failed` or `provisioning`, the message points at `tenancy.provision(id)`. `PrismaTenantSource` and `SqliteTenantSource` gain an insert-only `create()` that maps the unique violation to that error, so concurrent creates of the same id have exactly one winner; `MemoryTenantSource.create()` now refuses duplicates too, and `basalt tenant:create` reports an existing id with exit code 1.

**Behaviour change:** `create()` no longer overwrites an existing tenant. Previously it fell back to the durable sources' `save()` upsert and replaced the whole record (owner, status, domains) and re-ran provisioning. Use `save()` for an intentional upsert and `provision(id)` to retry a failed tenant. `PrismaTenancyClient['tenant']` now also requires `create` — a generated `PrismaClient` already has it; only a hand-written fake needs the method added.
