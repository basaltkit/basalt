# @basaltkit/search-postgres

## 1.0.4

### Patch Changes

- 36ab1a1: Cast the language parameter to `regconfig` in `to_tsvector` and `plainto_tsquery`.
  
  `PgClientLike` accepts any client with a `query()` method, and clients disagree
  on parameter typing. `pg` sends parameters untyped and lets Postgres infer `$5`
  as `regconfig`; Prisma sends them as `text`, and `to_tsvector(text, text)` does
  not exist — every index and search failed with error 42883.
  
  That made this driver unusable with the client `@basaltkit/prisma` recommends:
  two official packages of the same toolkit that did not fit together. Apps hit it
  as a hard failure on the first indexed document, and worked around it by
  rewriting the driver's SQL with a regular expression before executing it.
  
  The cast is redundant under `pg` and required under Prisma, so it belongs here
  rather than in every application. No API change; parameter numbering and query
  shape are unchanged.

## 1.0.3

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- 104cfb3: `register()` no longer emits an invalid `CREATE INDEX` for a schema-qualified table.
  
  `assertValidTableName` accepts `schema.table`, but `register()` built the index name by appending to it — `CREATE INDEX IF NOT EXISTS app.search_tsv_idx …`. Index names cannot be schema-qualified in Postgres, so that is a syntax error and `register()` failed outright for anyone using a non-default schema. The separator is now flattened (`app_search_tsv_idx`); the index still lands in the table's own schema, and unqualified names are byte-for-byte unchanged.
- Updated dependencies [104cfb3]
  - @basaltkit/search@1.3.2

## 1.0.1

### Patch Changes

- Validate the `table` option (optionally schema-qualified) at construction so it can not inject into the interpolated DDL/DML.

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
