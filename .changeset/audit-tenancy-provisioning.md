---
'@basaltkit/audit': patch
---

Stop the default configuration from breaking tenant provisioning, and add
`onCaptureError`.

Two independent problems, both from `tenancy:**` being in the default hook
patterns:

**Tenant creation failed outright.** `tenancy.provision()` runs the provisioning
callback inside the new tenant's context, which emits `tenancy:switched`. With
an `AuditStore` bound to the tenant's own database — the natural setup for
schema-per-tenant — that write hit storage that did not exist yet. The awaited
listener had no `try/catch`, so the rejection propagated out through
`provision()`, which marked the tenant `failed` and rethrew. An application
following the defaults could not create a single tenant.

**The trail filled with routing noise.** `tenancy:switched` also fires on every
HTTP request that resolves a tenant, so a multi-tenant app wrote one audit row
per request, forever.

The default patterns now name `tenancy:created` instead of `tenancy:**`: tenant
lifecycle is worth auditing, context switching is routing. The two were only
together because one wildcard covered both.

Bridged captures — hooks and events the plugin picks up automatically — no
longer propagate failures into the operation that emitted them. `onCaptureError`
reports them, defaulting to a log; the same rule `@basaltkit/realtime` applies to
its own bridge. A deliberate `audit.record()` still throws, because there the
audit *is* the operation.

Apps that want the old capture set can pass `hooks: ['auth:**', 'billing:**',
'tenancy:**', 'permission:**']` explicitly.
