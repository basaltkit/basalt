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
