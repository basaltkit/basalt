---
'@basaltkit/teams-sqlite': patch
'@basaltkit/teams-prisma': patch
---

`findPending(tenantId, email)` now matches the canonical address (trimmed, lower-cased) on both sides, so a pending invitation stored as `Bob@x.test` is found for `bob@x.test` — including legacy mixed-case rows (FA-045). The comparison runs in JS: SQLite's `lower()` only folds ASCII, and Prisma's `mode: 'insensitive'` is PostgreSQL/MongoDB-only. No schema or data migration.
