---
'@basaltkit/activity': patch
---

security: with `tenantScoped: true` (the default), the context tenant now always wins over a caller-supplied `query.tenantId`, so a forwarded tenant id can no longer widen a feed query to another tenant; an explicit `tenantId` is still honoured when no tenant is in context, and `tenantScoped: false` remains the explicit opt-out.
