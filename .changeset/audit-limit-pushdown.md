---
'@basaltkit/audit-prisma': minor
'@basaltkit/audit-sqlite': minor
---

Audit queries push their limit into the database instead of loading the whole trail.

Both stores ran `findMany` / `SELECT *` with no `take` / `LIMIT` and applied the event pattern and the limit **in JavaScript afterwards**. An authenticated `GET /audit?limit=50` therefore materialised the entire, unbounded tenant trail — a repeatable OOM on any endpoint that forwards client input.

Exact filters now push down, including an event name with no wildcard (`take: limit` / `LIMIT n`). Only a wildcard pattern still needs matching in code, and then rows are read in bounded 500-row pages that stop as soon as the limit is satisfied. A pattern containing `.` is deliberately *not* pushed down: `patternMatches` treats `.` and `:` as interchangeable separators, so an equality would miss `a:b` for the pattern `a.b`.

Results are unchanged — same rows, same order, same limit semantics — only peak memory differs.
