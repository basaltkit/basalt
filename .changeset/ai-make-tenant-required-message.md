---
'@basaltkit/ai': patch
---

The repository `ai:make` generates for a tenant-scoped model no longer tells the client to "send the x-tenant-id header" when no tenant is resolved: an app that resolves tenants by subdomain (or domain, or route) ignores that header. The message now points at however `tenancyPlugin` resolves tenants in that app.
