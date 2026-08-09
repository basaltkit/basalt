# @basaltkit/search-postgres

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

- @basaltkit/search@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/search@0.23.0

## 0.22.0

### Minor Changes

- 8471acb: New package: `@basaltkit/search-postgres` — a PostgreSQL full-text search driver for `@basaltkit/search`.

  `PostgresSearchDriver` implements the `SearchDriver` contract on top of Postgres' native full-text search (`tsvector`/`tsquery`/`ts_rank`). All indexes share one table keyed by (index, tenant, id) with a GIN index on the `tsvector`; the searchable fields feed `to_tsvector(<language>)` (default `english`, with stemming), and every query is constrained to the caller's tenant so results never leak. Filters become `document->>'field' = $value` (or `= ANY(...)` for arrays), and results are ranked by `ts_rank`. Bring your own `pg` Pool/Client — it's injected, so the whole SQL layer is unit-tested with a fake, no database required. This joins `MemorySearchDriver` (dev) and `MeilisearchDriver` behind the same API.

### Patch Changes

- @basaltkit/search@0.22.0
