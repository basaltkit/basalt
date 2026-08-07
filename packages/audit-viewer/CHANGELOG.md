# @machize/audit-viewer

## 0.16.0

### Minor Changes

- ca0d911: New package: `@machize/audit-viewer` — a read-only lens over the `@machize/audit` trail.

  `AuditViewer` wraps `Audit` to give tenant-scoped, filterable, paginated queries (`page`) and aggregate stats (`stats`: by event, by actor, by source, and a bucketed timeline), plus `get(id)`. `ViewerQuery` filters by event wildcard, actor, source (`hook`/`event`/`manual`) and a `since`/`until` time range; the tenant comes from the argument or the request context. `auditViewerRoutes()` exposes `GET /audit`, `/audit/stats`, `/audit/:id` and a self-contained, dependency-free HTML browser at `/audit/view` (filters, table, pagination), all requiring a logged-in user. `auditViewerPlugin({ bucketMs, topN })` registers the `AUDIT_VIEWER` token. The trail stays append-only — this package only reads. Fully unit-tested (paging, filters, stats, the HTML page, and the HTTP routes).

### Patch Changes

- @machize/audit@0.16.0
- @machize/core@0.16.0
- @machize/fastify@0.16.0
