---
'@basaltkit/audit-viewer': minor
---

The viewer bounds how much of the trail it reads, and says when it hit the bound.

`page()`, `get()` and `stats()` all called `audit.trail()` with no limit — the aggregates genuinely need more than one page, but "all of it" is unbounded on a trail that only ever grows. Every call now reads at most `maxScan` rows (default **10 000**, configurable on `auditViewerPlugin`/`new AuditViewer`).

`AuditPage` and `AuditStats` gain `truncated: boolean`, true when the scan hit the bound — so `total` is honestly "matches within the window" rather than a silently wrong grand total, and a UI can say so. Trails smaller than `maxScan` behave exactly as before.
