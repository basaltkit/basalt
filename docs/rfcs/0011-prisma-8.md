# RFC 0011 — Prisma 8: tenant isolation and the package architecture

- **Status:** Draft, for approval.
- **Direction agreed by the maintainer:** `@basaltkit/prisma` stays on Prisma 7. Prisma 8 support goes in a separate `@basaltkit/prisma8`, built after Prisma 8 is stable.
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-23
- **Evidence:** `apps/prisma8-integration`, 38 tests in 8 files against PostgreSQL 16, on `@prisma/orm-postgres` 8.0.0-rc.20 and the `prisma` CLI 8.0.0-rc.27. The suite was green five times in a row with the file order shuffled, and in CI.
- **Affects (later):** a new `@basaltkit/prisma8`, store subpaths, `create-basalt`, `@basaltkit/generator`, `@basaltkit/deploy`, the docs. Nothing in this RFC changes a stable package.
- **Non-negotiables:**
  - Tenant isolation fails closed.
  - Prisma 7 support stays as it is.
  - Nothing experimental reaches a stable package.
  - No existing application changes behaviour without tests.

---

## 0. TL;DR

- **Prisma 8 is a new ORM.**
  - Its client is `@prisma/orm-postgres`, and queries are chained builders.
  - `$extends`, the `P2xxx` codes, `Date` values and `migrate deploy` are gone.
  - There is no MySQL.
- **Schema-per-tenant has no supported path on the RC.**
  - The ORM writes the schema into every statement, and the client has no schema option.
  - Prisma's own late binding (`namespace unbound`) is broken (prisma/orm#30722).
  - There is one migration marker per database.
- **A design under Basalt's control is proven by tests:**
  - one client per tenant from a contract copy;
  - the connection's `search_path` for raw SQL;
  - a hardened per-schema migration runner.
- **Row-level tenancy:** RLS with `set_config(…, true)` per transaction is Prisma's documented pattern. The tests show it is the guarantee: it covers includes and prepared statements. A tenant-filter middleware covers neither, so it is defence in depth only.
- **Recommendation:**
  - Build `@basaltkit/prisma8` after GA, with that design.
  - The stores get `/prisma8` subpaths.
  - Extracting a shared core out of the stable package is **deferred** (§6.2).
  - The two upstream proposals stay drafts (Appendix A).

## 1. What was tested

| File | Tests | Shows |
|---|---|---|
| `schema-per-tenant.test.ts` | 5 | `db update` per tenant schema; one typed client per tenant via the contract copy; the ORM ignores the `search_path`; the central update restores the marker |
| `isolation.test.ts` | 6 | Concurrent writes of two tenants, model reads, raw SQL, a rolled-back transaction, a `23505` error and concurrent transactions where one fails. No row crossed schemas |
| `rls.test.ts` | 7 | Prisma's RLS pattern as a non-owner role:<br>• nothing is visible or writable without a tenant (`42501`);<br>• a write for another tenant is refused;<br>• nothing leaks on a reused connection, after a failure, or between concurrent tenants;<br>• a **session**-level setting leaks;<br>• `db update`, even for one tenant schema, plans to drop an undeclared policy, and refuses without `--allow` |
| `middleware.test.ts` | 3 | `beforeCompile` cannot redirect to an undeclared schema (`RUNTIME.NAMESPACE_UNKNOWN`). It filters reads, updates and deletes, but not inserts |
| `prepared-includes.test.ts` | 4 | The middleware does **not** filter rows loaded through `include(...)`. A prepared statement **keeps the tenant its middleware saw when it was prepared**. RLS covers both |
| `unbound.test.ts` | 3 | `namespace unbound` is qualified `"__unbound__"` at runtime (#30722). `db update` plans no DDL for it |
| `migration-files.test.ts` | 9 | `db migrate` per tenant is refused (`MIGRATION.MARKER_MISMATCH`). The hardened runner, layer by layer: graph order, idempotence, whole-or-nothing, the tenant role, and the refusals (data transform, cross-tenant operation, tampered package). The database layer holds with validation skipped. The validator is unit-tested |
| `load.test.ts` | 1 | 30 tenants, 600 concurrent operations through Basalt's `TenantClientPool` (8 clients × 2 connections). Zero rows in a wrong schema, raw SQL always in the tenant's schema, peak connections 17 (the bound plus one admin). About 4–6 s locally |

## 2. What Prisma supports, and how firmly

The labels are:
- **Official:** documented and supported.
- **Experimental:** in code or design notes only, or broken.
- **Ours:** works in our tests, but rests on details Prisma does not document.
- **Unvalidated:** not tested here.

| Need | Status | Source / evidence |
|---|---|---|
| Choose the PostgreSQL schema per client | **None official.** `postgres()` takes `contract`, `url`/`pg`/`binding`, `poolOptions`, `middleware`, `verifyMarker`, `log`, `cursor` and `collections` | The RC's `runtime.d.mts`; /docs/orm/reference/transactions-and-runtime |
| `search_path` choosing the schema of ORM queries | **Not supported.** Named namespaces are always qualified | "the path always includes the schema name" (/docs/orm/fundamentals/writing-data); `schema-per-tenant.test.ts` |
| `namespace unbound` (late binding through `search_path`) | **Experimental and broken** at runtime and in `db update` | prisma/orm#30722 (open); `unbound.test.ts` |
| A per-tenant contract copy (storage namespace id = tenant schema) | **Ours** | `schema-per-tenant`, `isolation`, `load` tests |
| Middleware AST rewrite (`beforeCompile`) | **Official**, documented for tenant filters, with a warning not to rely on it alone | /docs/orm/middleware/authoring-custom-middleware; `middleware.test.ts` |
| Middleware and includes | Official warning ("joined" and included rows are not filtered). **Confirmed:** another tenant's included row shows | `prepared-includes.test.ts` |
| Middleware and prepared statements | **Not documented.** Prisma documents only that middleware does not run for `db.toSql(plan)`. **Tested:** the filter is compiled once, at prepare time, and a later tenant gets the first tenant's rows | `prepared-includes.test.ts` |
| Middleware redirecting a query to another schema | **Not possible** (`RUNTIME.NAMESPACE_UNKNOWN`) | `middleware.test.ts` |
| RLS policies and `set_config` per transaction | **Official** | /docs/orm/contract-authoring/psl-syntax#row-level-security, /advanced-postgresql; `rls.test.ts`, `prepared-includes.test.ts` |
| Transactions pinned to one connection, raw SQL inside | **Official** | /docs/orm/reference/transactions-and-runtime |
| Migration packages: structured `ops.json` (target schema, `execute` SQL), attested hash, `migration check` | **Official** | /docs/orm/reference/migration-api; `migration-files.test.ts` |
| Per-schema migrations through the CLI | **Not supported.** One marker per database; ADR 021's per-schema locator is not implemented | `migration-files.test.ts` |
| Hand-written operations (`rawSql`) | Official. Their `target` is "always `{ id: 'postgres' }`", with **no schema** | /docs/orm/reference/migration-api; `migration-files.test.ts` |
| A Basalt runner applying packages per schema | **Ours** | `migration-files.test.ts` |
| Errors as SQLSTATE (`23505`, `42501`) | Official (structured errors) | `isolation`, `rls` tests |
| MySQL | **None** | /docs/orm/supported-versions |

## 3. Confirmed incompatibilities

1. `pgSchemaClient` (Prisma 7) does not carry over: the schema is in the SQL (#503 corrected the docs).
2. A Prisma 8 client cannot be pointed at a schema the contract does not name, at runtime or in middleware.
3. `db migrate` cannot migrate several tenant schemas of one database (`MIGRATION.MARKER_MISMATCH`).
4. `migration plan` needs an explicit origin once files exist (`MIGRATION.PLAN_ORIGIN_UNKNOWN`). Package directories are minute-stamped, so **name order is not migration order**: two packages planned in the same minute sort by name. Order must follow the graph (`migration.json` `from`/`to`).
5. `db update` diffs the whole database, even for one tenant's namespace, and treats undeclared RLS policies as drift.
6. The RC pins `pg` 8.22.0 and `@types/pg` 8.20.4 exactly.
7. Gone Prisma 7 surfaces used by `@basaltkit/prisma` and the stores:
   - `$extends`
   - batch `$transaction([...])`
   - `$executeRawUnsafe` / `$queryRawUnsafe`
   - `P2xxx` codes
   - `_prisma_migrations`
   - `migrate deploy/status`, `db push`
   - `take`, `skipDuplicates`, `{ increment }`, `mode: 'insensitive'`, `has`
   - `Date` values

## 4. Risks to tenant isolation and RLS

### 4.1 Tested

| Risk | Evidence | Mitigation in the design |
|---|---|---|
| Raw SQL silently reads `public` when a tenant client has the contract routing but not the `search_path` | `isolation.test.ts` | One function builds the tenant connection: the contract copy plus the `search_path`, with a plain-identifier check. `current_schema()` is asserted per tenant, under load too |
| A session-level tenant setting leaks to the next request on the same connection | `rls.test.ts` | Tenant set only with `set_config(…, true)` inside a transaction. No session variant offered. The test keeps proving the leak |
| Middleware does not filter included rows | `prepared-includes.test.ts` | Middleware is never the guarantee. RLS (or a schema per tenant) is. RLS filters included rows (tested) |
| A prepared statement keeps the tenant its middleware saw when it was prepared | `prepared-includes.test.ts` | The package does not combine middleware tenant filters with prepared statements. Under RLS, one prepared statement serves every tenant correctly (tested) |
| Middleware does not guard inserts | `middleware.test.ts` | RLS `WITH CHECK` refuses a cross-tenant write (`rls.test.ts`) |
| `db update` plans to drop RLS policies the contract does not declare, even for one tenant | `rls.test.ts` | Policies live in the contract (`@@rls`/`policy_*`). Tenant schemas are migrated only by the runner, which never diffs. `--allow` is never automated |
| A migration reaches another tenant's schema: a hand-written `rawSql` declares no schema | `migration-files.test.ts` | The runner refuses any operation without the tenant as its target. Every `execute` statement is validated (one statement, allowed DDL, no grants, roles, settings, functions or policies, only the tenant's schema). The package runs under a role that owns only that schema, and the database refuses with validation skipped |
| A TypeScript `dataTransform` replayed in every tenant | `migration-files.test.ts` | Refused (`operationClass: "data"`): it is compiled against one tenant's contract and rows |
| A package edited after it was attested | `migration-files.test.ts` | `migration check` refuses (`MIGRATION.CHECK_HASH_MISMATCH`). This is integrity, not authorship: re-attesting is possible, so validation and the database role do not trust it |
| Out-of-order migrations (name order ≠ graph order) | `migration-files.test.ts` | The runner orders by the graph, and refuses a fork or a gap |
| A half-applied migration | `migration-files.test.ts` | One transaction per package, with its ledger row; the role cannot write the ledger |
| A shared marker pointing at a tenant's hash | `schema-per-tenant`, `migration-files` tests | The runner never writes the marker. The central plane uses the official `db migrate` |
| Many tenants: rows crossing schemas or unbounded connections | `load.test.ts` | `TenantClientPool` bounds clients. Isolation and the connection bound held under 600 concurrent operations |

### 4.2 Not yet validated

| Risk | Why it matters | Next step |
|---|---|---|
| The contract copy breaks when Prisma changes the contract format | Routing would fail. A guard throws if `storage.namespaces.public.id` moves | The nightly RC job runs the suite. Move to `namespace unbound` when #30722 is fixed |
| Joins built with the SQL builder (`db.sql…join`) under middleware | Same class as includes. Expected unfiltered, not tested | Add a test before any middleware is offered |
| Pool sizing under real traffic | With 30 active tenants and 8 slots the pool churned (≈370 clients created for 600 operations). Correct, but slow | Size `max` to the tenants active together. Measure with a real app |
| Runner validation by pattern | It parses SQL with patterns, not a parser. The database role is the real boundary | Keep both layers. Consider a real SQL parser |
| `Temporal` values across the stores | Different value types in every store | Decide on a shared codec layer in the store work |
| Prepared statements inside RLS transactions on PgBouncer (transaction pooling) | Not tested | Test before recommending PgBouncer |

## 5. The two architectures

**A. Two packages.** `@basaltkit/prisma` stays on Prisma 7, and `@basaltkit/prisma8` serves Prisma 8.

**B. One package, a new major.** `@basaltkit/prisma` 5 serves Prisma 8, or both versions.

| | A: separate package | B: major of the same package |
|---|---|---|
| **Compatibility** | Prisma 7 apps change nothing and keep patches for as long as Prisma 7 is supported (18 months after Prisma 8 GA) | Prisma 7 apps are stranded on 4.x, or the package carries both Prisma versions with optional peers and runtime detection |
| **API coherence** | Each package documents one Prisma | The same names would mean different things per Prisma version |
| **Maintenance** | Two packages. Shared Prisma-agnostic pieces are possible later (§6.2) | Two code paths in most modules (extension, RLS, raw SQL, errors, migrate, status, sync) |
| **Experience** | One import per Prisma version. `create-basalt` picks it | One import, with a "7 or 8" matrix on every option |
| **Existing apps** | None, until each app chooses. producer-basalt (MySQL) stays on 7 | A major every app must take |
| **Stable line** | Untouched | Carries Prisma 8 code |

**The stores** type their client structurally and have no Prisma dependency. A `/prisma8` subpath per store package keeps one package per domain and adds no dependency.

## 6. Recommendation

### 6.1 The plan

1. **Now:**
   - Keep the harness and the nightly RC job.
   - Extend the harness for §4.2.
   - No stable package changes.
2. **After Prisma 8 GA:** build `@basaltkit/prisma8` (0.x until one app has run on it):
   - **Schema per tenant:** the contract copy plus the `search_path` from one guarded function, and clients from a bounded pool.
   - **Migrations:** the runner as tested, in five layers:
     1. graph order;
     2. `migration check`;
     3. validation of every operation;
     4. a per-tenant owner role;
     5. one transaction per package, with its ledger row.

     Central migrations go through the official `db migrate`. RLS policies are declared in the contract.
   - **Row level:** RLS, with the tenant set by `set_config(…, true)` per transaction. Middleware filters only as defence in depth, never with prepared statements, and never as the only guard.
   - **Errors:** read by SQLSTATE.
3. **Then:**
   - store `/prisma8` subpaths;
   - `create-basalt --prisma8`;
   - generator templates;
   - `@basaltkit/deploy` (`contract emit`, `db migrate`);
   - docs split by Prisma version.
4. **When #30722 is fixed** (and unbound DDL works), re-run `unbound.test.ts`. Prefer Prisma's own late binding over the contract copy.

### 6.2 Deferred: extracting a shared core

Moving the Prisma-agnostic pieces (`TenantClientPool`, the request lease, `tenantSchema`, `ShardRouter`) out of `@basaltkit/prisma` into a shared module is **not part of this plan**. The load test uses `TenantClientPool` from the stable package as it is, with Prisma 8 clients. That shows the Prisma 8 package can depend on `@basaltkit/prisma` (or copy the pool) without touching it.

The refactor will be proposed separately, only when:
- there is a concrete need, such as a fix that must land in both packages;
- regression tests pin the stable package's behaviour before the move.

## 7. Proposals to Prisma

The tests show two separate limitations of the API, beyond the bug Prisma already tracks (#30722). They are kept apart because they are different problems that can be solved independently:

- **A.1 — Binding a client to a schema at runtime.** Queries only.
- **A.2 — Migrating several schemas of one database.** Marker and DDL.

Both drafts are in Appendix A, **for review only, not filed**. Their minimal reproductions were run verbatim in an empty project on 2026-10-23 (results quoted).

## 8. Open questions

- Joins through the SQL builder under middleware (§4.2).
- Whether `@basaltkit/prisma8` depends on `@basaltkit/prisma` for the pool, or copies it until §6.2 happens.
- PgBouncer in transaction mode with prepared statements and `set_config(…, true)`.
- A SQL parser for the runner's validation.

---

## Appendix A — draft proposals to the Prisma team (for review, not filed)

Common context for both:

> We maintain a framework (BasaltKit) whose apps run one PostgreSQL schema per tenant in one database, on Prisma 7 today. We are preparing Prisma 8 support and tested the RC (`@prisma/orm-postgres` 8.0.0-rc.20, CLI 8.0.0-rc.27) against PostgreSQL 16. Our harness has 38 tests covering isolation, RLS, migrations and load, and we are happy to test patches against it.

### A.1 — Bind a client to a PostgreSQL schema at runtime

> **Problem.** There is no supported way to make one contract's models run in a schema chosen at runtime.
> - The ORM qualifies every statement with the contract namespace (`INSERT INTO "public"."Project"`), so a connection's `search_path` does not change it.
> - `postgres()` has no schema option.
> - A `beforeCompile` middleware cannot point a query at a schema the contract does not declare (`RUNTIME.NAMESPACE_UNKNOWN`).
> - `namespace unbound` would fit, but it is qualified as `"__unbound__"` after `contract.json` is loaded (#30722).
>
> **Minimal reproduction.** Run in an empty project on PostgreSQL 16 on 2026-10-23, with `prisma@8.0.0-rc.27`, `@prisma/orm-postgres@8.0.0-rc.20`, `@prisma/cli-engine@0.9.0` and `pg@8.22.0`.
>
> `contract.prisma`:
> ```prisma
> // use prisma-8
> model Project {
>   id   String @id
>   name String
> }
> ```
> `prisma.config.ts`:
> ```ts
> import { definePrismaConfig } from '@prisma/cli-engine'
> import { defineConfig as ormConfig } from '@prisma/orm-postgres/config'
> export default definePrismaConfig({ orm: ormConfig({ contract: './contract.prisma', db: { connection: process.env['DATABASE_URL']! } }) })
> ```
> Then:
> ```sh
> prisma contract emit && prisma db init --yes
> psql "$DATABASE_URL" -c 'CREATE SCHEMA tenant_a; CREATE TABLE tenant_a."Project" (LIKE public."Project" INCLUDING ALL);'
> node repro.ts
> ```
> `repro.ts`:
> ```ts
> import pg from 'pg'
> import postgres from '@prisma/orm-postgres/runtime'
> import { contractFromJson } from '@prisma/orm-postgres/static'
> import contract from './contract.json' with { type: 'json' }
>
> const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=tenant_a' })
> const db = postgres({ contract: contractFromJson(contract as never), pg: pool })
> await db.orm.public.Project.create({ id: '1', name: 'tenant a' })
> await db.close(); await pool.end()
> ```
> **Observed:** `public."Project"` holds 1 row and `tenant_a."Project"` holds 0.
>
> **Workaround we use.** We copy the contract and set `storage.namespaces.public.id` to the tenant's schema. Every statement is then routed correctly, but this relies on the contract's internal shape.
>
> **Ask.** Either of these, keeping the generated types (`db.orm.public.*`):
> - a supported runtime binding, such as `postgres({ contract, url, namespaces: { public: 'tenant_a' } })` or `contract.withNamespace('public', 'tenant_a')`;
> - `namespace unbound` working at runtime (#30722).

### A.2 — Migrate several schemas of one database

> **Problem.** Prisma 8 records migration state in `prisma_contract.marker`, one row per space per database. A contract for a second schema of the same database cannot be migrated with `db migrate`: it fails with `MIGRATION.MARKER_MISMATCH`, because the marker holds the other contract's hash.
> - The only ways out the CLI suggests (`db sign`, `migration ref set`) overwrite that shared marker.
> - `db update` instead diffs the whole database. Even for one schema's namespace contract, it treats objects outside that schema (for example an RLS policy in `public`) as drift.
> - It plans no DDL at all for `namespace unbound` ("effective control 'external'").
> - ADR 021 describes a per-schema marker locator, but it does not seem to be implemented.
>
> **Minimal reproduction.** Same project as A.1, after `db init`. Add `tenant_a/contract.prisma`:
> ```prisma
> // use prisma-8
> namespace tenant_a {
>   model Project {
>     id   String @id
>     name String
>   }
> }
> ```
> Copy `prisma.config.ts` next to it, then run in `tenant_a/`:
> ```sh
> prisma contract emit --config prisma.config.ts
> prisma migration plan --name init --config prisma.config.ts
> prisma db migrate --config prisma.config.ts --yes
> ```
> **Observed:** `✘ [MIGRATION.MARKER_MISMATCH] Database marker is not reachable in the on-disk migration graph`. The schema `tenant_a` has no tables.
>
> **Workaround we use.** We plan and attest the packages with Prisma, then apply each package's `execute` SQL to one schema ourselves, with our own ledger. That means graph order, `migration check`, our own validation, and a role that owns only that schema. The marker is never touched.
>
> **Ask.** A supported way to track migrations per schema within one database. That could be the marker locator of ADR 021 (a marker keyed by schema), or `namespace unbound` DDL emitted unqualified for the connection's `search_path`, applied once per schema with its own marker. A `db update` scope limited to the contract's namespaces would also help.
