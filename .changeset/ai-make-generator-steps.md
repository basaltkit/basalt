---
'@basaltkit/ai': patch
---

`ai:make` builds every resource a `make:resource` step names, even when the model left it out of `entities` — the common case when the Prisma models already exist, where ai:make used to stop with "Nothing to scaffold". The missing entity takes its fields from the existing model (scalars and enums; relations stay in the schema). The planner prompt now also requires each generator step's entity to be listed. `PrismaModel` gains `columns` (name, type, optional, list).
