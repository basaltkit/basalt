---
'@basaltkit/prisma': minor
'@basaltkit/search-postgres': minor
---

Keep the GIN index when full-text search runs under row-level security (BK-023).

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
