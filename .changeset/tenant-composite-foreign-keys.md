---
"@basaltkit/ai": minor
"@basaltkit/generator": minor
"create-basalt": patch
---

Composite foreign keys for tenant-scoped models (#582).

- **`@basaltkit/ai`:** new `ai:doctor` rule `tenant-fk-not-composite` (warning). It reports a relation between two tenant-scoped models whose foreign key leaves `tenantId` out. With such a key, the database accepts a link to another tenant's row, and an `include` then reads that row back, because the tenancy extension does not check a foreign-key scalar written in `data`. The fix is a composite key, `(tenantId, <fk>) → (tenantId, id)`. The schema parser now reads `@relation(fields, references)`, and each column exposes it as `PrismaColumn.relation` (new exported type `PrismaRelation`). `ai:make` adds `@@unique([tenantId, id])` to a tenant-scoped model it injects fields into.
- **`@basaltkit/generator`:** `make:resource --prisma` in `column` tenant mode adds `@@unique([tenantId, id])` to the model, which is the target a composite foreign key references.
- **`create-basalt`:** the scaffold's `Project` model gets the same unique pair when tenancy is on.

Security guide (EN+PT): new "Composite foreign keys" section.
