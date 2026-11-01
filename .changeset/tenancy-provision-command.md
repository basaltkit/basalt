---
'@basaltkit/tenancy': minor
---

- `basalt tenant:provision <id>`: finishes or retries a `provisioning`/`failed` tenant through `tenancy.provision(id)` — runs `onProvision`, writes `ready`, emits `tenancy:created`. A throwing hook exits 1 with the cause (the tenant stays `failed`) instead of a stack trace.
- `basalt tenant:create` with `provision: 'deferred'` no longer prints "Created and provisioned": it says the tenant is still `provisioning` (503) and points at the job or `tenant:provision`.
- `tenancy.provision()` refuses a `suspended` or `deleting` tenant with `TenantNotProvisionableError` (409, `TENANT_NOT_PROVISIONABLE`). It used to write `ready` there, lifting a suspension the app had set or reviving a tenant halfway through `destroy()`.
