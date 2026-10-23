# prisma8-integration

Prisma 8 readiness harness. It runs schema-per-tenant on `@prisma/orm-postgres` against
a real PostgreSQL server, so that Basalt can support Prisma 8 the day it reaches general
availability, not months later. It lives beside `apps/pg-integration` (Prisma 7), and it
is private: nothing here is published.

## What it proves

| Test | What a Basalt Prisma 8 integration rests on |
|---|---|
| provisions each tenant schema | `prisma db update` with the central contract wrapped in `namespace tenant_<id> { … }` plans and applies only that schema's DDL (`CREATE SCHEMA`, `CREATE TABLE`) |
| routes one typed client per tenant | a copy of `contract.json` whose `storage.namespaces.public.id` is the tenant schema sends every statement there. The app keeps `db.orm.public.Project` and its generated types |
| records the RC behaviour | the ORM qualifies its SQL (`"public"."Project"`), so a connection's `search_path` does **not** choose the schema. If this test starts failing, the news is good |
| evolves one tenant schema | an added field plans exactly `ALTER TABLE "tenant_acme"."Project" ADD COLUMN …`; the other tenants are untouched |
| restores the central marker | the migration marker (`prisma_contract.marker`) is one per database, and each tenant update overwrites it. Updating the central plane last plans nothing and puts it back |

### Isolation, RLS, middleware, migrations (RFC 0011)

| File | Tests | What it shows |
|---|---|---|
| `isolation.test.ts` | 6 | Concurrent writes, model reads, raw SQL, transactions, a `23505` error and concurrent transactions, with one client per tenant schema. Raw SQL reaches the tenant schema only through the connection's `search_path`; a contract-routed client without it silently reads `public` |
| `rls.test.ts` | 7 | Prisma's documented RLS pattern: a non-owner role, a policy on `current_setting('app.tenant_id')`, and `set_config(…, true)` inside the transaction. Nothing is visible without a tenant, writes for another tenant are refused (`42501`), and nothing leaks to the next query on the same connection, after a failure or under concurrency. A **session**-level `set_config(…, false)` does leak. `db update`, even for one tenant schema, plans to drop the undeclared policy and refuses without `--allow`. The file drops its policy when it finishes, so the other files see the database as the contract declares it |
| `middleware.test.ts` | 3 | `beforeCompile` cannot send a query to a schema the contract does not declare (`RUNTIME.NAMESPACE_UNKNOWN`). It does filter reads, updates and deletes by tenant, but it does not guard inserts, so RLS remains the guarantee |
| `unbound.test.ts` | 3 | Records prisma/orm#30722: `namespace unbound` emits as `"__unbound__"` and the ORM qualifies with it instead of using the `search_path`. `db update` plans no DDL for an unbound namespace |
| `migration-files.test.ts` | 4 | `db migrate` per tenant is refused (`MIGRATION.MARKER_MISMATCH`, one marker per database). A Basalt-owned runner applies the planned files' SQL per schema with its own ledger: idempotent, only the evolving tenant changes, and a failing migration rolls back whole. Prisma's marker is never touched |

Two of these lean on details Prisma does not document: the contract's storage namespace
`id`, and the single marker per database. Watching those details from one RC to the next
is the reason this harness exists.

## Running it

```sh
TEST_DATABASE_URL=postgresql://basalt:basalt@localhost:5432/basalt_test \
  pnpm --filter prisma8-integration test:integration
```

TEST_DATABASE_URL names the server. The harness drops and recreates its own database,
`basalt_prisma8`, on that server, and never touches `basalt_test`. Without the variable,
the suite skips.

## CI

- **`prisma 8 rc (postgres)`** in `ci.yml` runs on every PR, with the RC that
  `package.json` and the lockfile pin. It is not a required check.
- **`.github/workflows/prisma8-rc.yml`** runs every night against the **latest** RC and
  commits nothing. If it goes red while the PR job stays green, a new RC broke something.

## Bumping the RC

1. Set the new exact versions of `prisma` and `@prisma/orm-postgres` in `package.json`.
   `@prisma/cli-engine` follows `prisma`'s own dependency.
2. Match `pg` and `@types/pg` to the exact versions `@prisma/orm-postgres` depends on. The
   RC pins them, and a `pg.Pool` from another `pg` does not typecheck.
3. Update the matching entries in `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
4. Run `pnpm install` (online), then `pnpm --filter prisma8-integration contract:emit`,
   and run the suite.

## When it fails

| Failure | Meaning | Response |
|---|---|---|
| `contractForSchema` throws "the Prisma 8 contract format changed" | the per-tenant client trick needs a new shape | adapt it in `tests/support/tenants.ts` |
| the search_path test fails | Prisma now honours `search_path` | good news: simplify the design |
| the marker test fails | Prisma changed how markers are kept | the Basalt tenant migration runner must follow it |
