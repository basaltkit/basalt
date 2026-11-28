---
"@basaltkit/ai": patch
---

`tenant-fk-not-composite` is now an **error**, not a warning (#582): a foreign key between tenant-scoped models without `tenantId` is a cross-tenant read path, and the composite-key fix costs nothing at run time. `ai:doctor` fails until it is fixed.
