# @basaltkit/audit-viewer

## 1.0.2

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/audit@0.24.0
- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/audit@0.23.0
- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/audit@0.22.0
- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/audit@0.21.0
- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/audit@0.20.0
- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/audit@0.19.0
- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/audit@0.18.0
- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/audit@0.17.0
- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0

## 0.16.0

### Minor Changes

- ca0d911: New package: `@basaltkit/audit-viewer` — a read-only lens over the `@basaltkit/audit` trail.

  `AuditViewer` wraps `Audit` to give tenant-scoped, filterable, paginated queries (`page`) and aggregate stats (`stats`: by event, by actor, by source, and a bucketed timeline), plus `get(id)`. `ViewerQuery` filters by event wildcard, actor, source (`hook`/`event`/`manual`) and a `since`/`until` time range; the tenant comes from the argument or the request context. `auditViewerRoutes()` exposes `GET /audit`, `/audit/stats`, `/audit/:id` and a self-contained, dependency-free HTML browser at `/audit/view` (filters, table, pagination), all requiring a logged-in user. `auditViewerPlugin({ bucketMs, topN })` registers the `AUDIT_VIEWER` token. The trail stays append-only — this package only reads. Fully unit-tested (paging, filters, stats, the HTML page, and the HTTP routes).

### Patch Changes

- @basaltkit/audit@0.16.0
- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0
