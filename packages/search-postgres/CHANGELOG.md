# @machize/search-postgres

## 0.23.0

### Patch Changes

- @machize/search@0.23.0

## 0.22.0

### Minor Changes

- 8471acb: New package: `@machize/search-postgres` — a PostgreSQL full-text search driver for `@machize/search`.

  `PostgresSearchDriver` implements the `SearchDriver` contract on top of Postgres' native full-text search (`tsvector`/`tsquery`/`ts_rank`). All indexes share one table keyed by (index, tenant, id) with a GIN index on the `tsvector`; the searchable fields feed `to_tsvector(<language>)` (default `english`, with stemming), and every query is constrained to the caller's tenant so results never leak. Filters become `document->>'field' = $value` (or `= ANY(...)` for arrays), and results are ranked by `ts_rank`. Bring your own `pg` Pool/Client — it's injected, so the whole SQL layer is unit-tested with a fake, no database required. This joins `MemorySearchDriver` (dev) and `MeilisearchDriver` behind the same API.

### Patch Changes

- @machize/search@0.22.0
