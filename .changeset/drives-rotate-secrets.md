---
"@basaltkit/drives": minor
---

Add `drives.rotateSecrets({ tenantIds? })`, which re-seals every stored credential still on a retired key (including dormant connections that never refresh) with a compare-and-set per row, and returns `{ resealed, skippedConflicts, remainingOnOldKeys }`. Tenant ids come from the app — the store contract gains no cross-tenant listing. The docs now warn that a tenant id is bound into every sealed secret and must never be renamed, and describe the full key-rotation runbook.
