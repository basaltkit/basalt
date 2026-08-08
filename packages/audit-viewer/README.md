# @machize/audit-viewer

**Read-only** viewer for the audit trail produced by [`@machize/audit`](https://www.npmjs.com/package/@machize/audit): **per-tenant**, filterable and paginated queries, with aggregated **statistics**, and a self-contained **HTML page** to browse it. You need this module when you want to give admins (or yourself) a way to review who did what — for support, compliance, or debugging.

## What this module solves

`@machize/audit` writes an *append-only* (immutable) trail of everything that happens. This module is the lens for reading it: filter by event/actor/period/source, paginate, view totals and distributions — plus a page ready to open in the browser. It never writes to or alters the trail.

## Installation

```bash
pnpm add @machize/audit-viewer @machize/audit
```

Depends on `@machize/core`, `@machize/audit`, and `@machize/fastify`. Requires the `auditPlugin` to be registered (that's where the trail comes from).

## Get started in 5 minutes

```ts
import { createApp } from '@machize/core'
import { auditPlugin } from '@machize/audit'
import { auditViewerPlugin, auditViewerRoutes, AUDIT_VIEWER } from '@machize/audit-viewer'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [
    auditPlugin(),
    auditViewerPlugin(),
    fastifyPlugin({ routes: [...auditViewerRoutes()] }),
  ],
}).boot()

// programmatically
const viewer = app.container.get(AUDIT_VIEWER)
const page = await viewer.page({ tenantId: 'acme', event: 'auth:**', limit: 50 })
const stats = await viewer.stats({ tenantId: 'acme' })
```

## Routes

`auditViewerRoutes()` (all require login — add your own admin *guard* on top):

| Route | Description |
|---|---|
| `GET /audit?event=&actorId=&source=&since=&until=&limit=&offset=` | Page of entries (most recent first) + `total`. |
| `GET /audit/stats?…` | Aggregates: by event, by actor, by source, timeline. |
| `GET /audit/:id` | A single entry. |
| `GET /audit/view` | HTML page for browsing (filters + table + pagination). |

All are **tenant-isolated** (the tenant comes from the request context).

## The HTML page

`GET /audit/view` serves a vanilla page (no build step, no dependencies) that calls the JSON routes and shows a filterable table with pagination. Customize the title/base path:

```ts
auditViewerRoutes({ title: 'Audit — Acme', apiBase: '/admin' })
```

## API reference

### `auditViewerPlugin({ bucketMs?, topN? })`

Registers the `AUDIT_VIEWER` token. `bucketMs` is the timeline bucket size (default 1 day); `topN` limits the per-event/actor tables (default 20).

### `class AuditViewer`

| Method | Description |
|---|---|
| `page(query)` | `{ entries, total, limit, offset }`. |
| `stats(query)` | `{ total, byEvent, byActor, bySource, timeline }`. |
| `get(id, tenantId?)` | A single entry, or `null`. |

`ViewerQuery`: `event` (wildcard), `actorId`, `tenantId`, `source` (`hook`/`event`/`manual`), `since`, `until`, `limit`, `offset`. Without `tenantId`, it uses `ctx().tenant.id` (otherwise `AuditTenantRequiredError`).

> Note: the extra filtering (source/until) and the aggregation happen in memory over the result of `Audit.trail`. For very large trails, use an `AuditStore` with rich database querying.

## How it connects to other modules

- **`@machize/audit`** — the immutable source of the trail (this module only reads it).
- **`@machize/permissions`** — adds a *guard* (`meta.can: 'audit:read'`) to restrict access to admins.
- **`@machize/exports`** — exports a query's result to CSV for compliance reports.
