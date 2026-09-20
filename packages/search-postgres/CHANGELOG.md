# @basaltkit/search-postgres

## 1.1.0

### Minor Changes

- d232f5f: Keep the GIN index when full-text search runs under row-level security (BK-023).
  
  Following both recommendations at once — `rlsPolicySql` /
  `tenancyExtension({ rls: true })` for tenant isolation, and
  `@basaltkit/search-postgres` for search — silently produced sequential scans.
  PostgreSQL may only evaluate a qualifier *before* a row-security policy when the
  qualifier is `LEAKPROOF`, and the text-search operator `@@` is not: for the
  application role the policy applies to, `tsv @@ plainto_tsquery(…)` can never be
  an index condition, so it is demoted to a filter applied after the policy and
  the GIN index drops out of the plan. Nothing warned, and small datasets never
  showed it. Measured here on 30 200 documents (PostgreSQL 16): `Bitmap Index Scan
  on basalt_search_tsv_idx`, 4.9 ms as the owner, against `Seq Scan`, 14.7 ms with
  30 197 rows discarded, as the RLS role — and the gap grows with the corpus.
  
  **`@basaltkit/prisma`** — new `rlsSearchFunctionSql(options)`, next to
  `rlsPolicySql` and built to the same rules as `crossTenantScanSql`: it generates
  an idempotent `SECURITY DEFINER` search function that re-applies the tenant
  predicate itself, so inside it `@@` is an index condition again (1.9 ms on the
  same data). It takes **no tenant parameter** — the tenant comes from
  `current_setting(<setting>, true)`, byte for byte the value the policy reads and
  the one the RLS extension already sets — so an unset setting yields no rows,
  never all rows. Pinned `search_path`, `STABLE` / `PARALLEL SAFE`, every
  identifier validated and quoted, `EXECUTE` revoked from `PUBLIC` and granted
  only to the roles you name, `p_limit` clamped to `maxRows`, filters and paging
  applied inside the function so the cap and the returned `total` stay honest.
  Options cover any RLS table with a `tsvector` column (`vectorColumn`,
  `partitionColumn`, `filterColumn`, `columns`, `language`, `parser`, `owner`, …),
  not just the search driver's table.
  
  **`@basaltkit/search-postgres`** — new `searchFunction` option on
  `PostgresSearchDriver` (`'fn'`, `'schema.fn'` or `{ name, schema }`). When set,
  **text** queries go through the generated function in one round trip instead of
  querying the table (a query with no `q` is plain equality, which *is* leakproof,
  so it keeps the direct path). The driver verifies every returned row against the
  query's `tenantId` and throws on a mismatch, so a connection left on another
  tenant or a function generated against a different `setting` than the policy is
  caught rather than served. No new dependency: the SQL generator is migration-time
  only.
  
  Both READMEs, the tenancy/RLS security guide and the search guide (EN + PT) now
  document the trap with before/after `EXPLAIN` output, give the recipe, and warn
  explicitly against the `ALTER FUNCTION ts_match_vq(…) LEAKPROOF` shortcut, which
  restores the index by weakening the leakproof rule database-wide. A plan guard
  rail in `apps/pg-integration` compares `EXPLAIN (FORMAT JSON)` as the owner and
  as the `NOBYPASSRLS` application role over a seeded 30 200-document corpus and
  fails if the fast path ever stops using the index.

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
