# RFC 0011 — Prisma 8: tenant isolation and the package architecture

- **Status:** Draft. It recommends an architecture; nothing is implemented beyond the test harness.
- **Author:** Marcio Zebedeu
- **Date:** 2026-10-23
- **Evidence:** `apps/prisma8-integration`, 27 tests against PostgreSQL 16, on `@prisma/orm-postgres` 8.0.0-rc.20 and the `prisma` CLI 8.0.0-rc.27.
- **Affects:** `@basaltkit/prisma`, the twelve `@basaltkit/*-prisma` store packages, `create-basalt`, `@basaltkit/generator`, `@basaltkit/deploy` and the docs.
- **Non-negotiables:**
  - Tenant isolation fails closed.
  - Prisma 7 support stays as it is.
  - Nothing experimental reaches a stable package.
  - No existing application changes behaviour without tests.

---

## 0. TL;DR

- **Prisma 8 is a new ORM, not a new Prisma 7.**
  - The client is `@prisma/orm-postgres`, and its queries are chained builders.
  - `$extends`, the `P2xxx` error codes, `Date` values and `migrate deploy` are gone.
  - It has no MySQL support.
- **Schema-per-tenant has no supported path on the RC.**
  - The ORM writes the schema into every statement, so the `search_path` cannot choose it.
  - The client has no `schema` option.
  - Prisma's own late-binding mechanism (`namespace unbound`) is broken (prisma/orm#30722).
  - There is one migration marker per database.
- **A path we control does work, and is tested.** The tenant isolation it gives (reads, writes, raw SQL, transactions, errors, concurrency) holds in every test:
  - one client per tenant, from a copy of the contract whose storage namespace is the tenant's schema;
  - the connection's `search_path` for raw SQL;
  - per-schema migrations applied by a Basalt-owned runner.
- **Row-level tenancy is officially supported.** RLS policies plus `set_config(…, true)` inside a transaction is Prisma's documented pattern. All six of its tests pass, including the leak a session-level setting would cause.
- **Recommendation:** keep `@basaltkit/prisma` for Prisma 7 and build Prisma 8 support as a separate package, after GA (§6). The stores get a `/prisma8` subpath in the packages they already live in. The pieces that do not depend on Prisma are extracted once and shared.

## 1. What was tested

All 27 tests ran twice in a row, green both times, against PostgreSQL 16 (`basalt_prisma8`). CI runs them on every PR (`prisma 8 rc (postgres)`) and nightly against the latest RC.

| File | Tests | Result | Shows |
|---|---|---|---|
| `schema-per-tenant.test.ts` | 5 | 5 ✓ | `db update` per tenant schema; one typed client per tenant via the contract copy; the ORM ignores the `search_path`; the central update restores the marker |
| `isolation.test.ts` | 6 | 6 ✓ | Concurrent writes of two tenants, model reads, raw SQL, a rolled-back transaction, a `23505` constraint error and concurrent transactions where one fails. No row ever crossed schemas |
| `rls.test.ts` | 6 | 6 ✓ | Prisma's documented RLS pattern as a non-owner role. Nothing is visible or writable without a tenant (`42501`). A write for another tenant is refused. Nothing leaks to the next query on the same connection, after a failure, or between concurrent tenants. A session-level setting **does** leak, as the test demonstrates |
| `middleware.test.ts` | 3 | 3 ✓ | `beforeCompile` cannot redirect to an undeclared schema (`RUNTIME.NAMESPACE_UNKNOWN`). It filters reads, updates and deletes, but does not guard inserts |
| `unbound.test.ts` | 3 | 3 ✓ (record a limitation) | `namespace unbound` is qualified as `"__unbound__"` at runtime (#30722), and `db update` plans no DDL for it |
| `migration-files.test.ts` | 4 | 4 ✓ | `db migrate` per tenant is refused (`MIGRATION.MARKER_MISMATCH`). A Basalt runner applies the planned files per schema: idempotent, one tenant at a time, a failing migration rolls back whole, and the marker is never touched |

## 2. What Prisma supports, and how firmly

The labels are:
- **Official:** documented and supported.
- **Experimental:** in code, skills or internal design notes, but undocumented or broken.
- **Ours:** works in the tests, but rests on details Prisma does not document.
- **Unvalidated:** not yet tested.

| Need | Status | Source / evidence |
|---|---|---|
| Choose the PostgreSQL schema per client | **None official.** `postgres()` takes `contract`, `url`/`pg`/`binding`, `poolOptions`, `middleware`, `verifyMarker`, `log`, `cursor` and `collections`, with no schema option | The RC's `runtime.d.mts`; /docs/orm/reference/transactions-and-runtime |
| `search_path` deciding the schema of ORM queries | **Not supported.** Named namespaces are always qualified | "the path always includes the schema name" (/docs/orm/fundamentals/writing-data); `schema-per-tenant.test.ts` |
| `namespace unbound` (late binding through `search_path`) | **Experimental, broken.** Mentioned for models only in the PSL interpreter. At runtime it is qualified `"__unbound__"` | prisma/orm#30722 (open); `unbound.test.ts` |
| A per-tenant contract (contract copy with storage namespace id = tenant schema) | **Ours** | `schema-per-tenant.test.ts`, `isolation.test.ts` |
| Middleware rewriting the query AST (`beforeCompile`) | **Official**, documented for "tenant isolation" filters with a warning not to rely on it alone | /docs/orm/middleware/authoring-custom-middleware; `middleware.test.ts` |
| Middleware sending a query to another schema | **Not possible:** `RUNTIME.NAMESPACE_UNKNOWN` | `middleware.test.ts` |
| RLS policies (PSL `@@rls`, `policy_*`) and `set_config` per transaction | **Official** | /docs/orm/contract-authoring/psl-syntax#row-level-security, /advanced-postgresql; `rls.test.ts` (policies created in SQL, same semantics) |
| Transactions pinned to one connection, raw SQL inside them | **Official** | /docs/orm/reference/transactions-and-runtime; `isolation.test.ts`, `rls.test.ts` |
| Per-schema migrations through the CLI | **Not supported.** One marker per database. ADR 021's per-schema `markerLocator` is not implemented | `migration-files.test.ts`; prisma/orm ADR 021 |
| `db update` per tenant namespace contract (live diff) | **Ours.** It works, but each run moves the shared marker | `schema-per-tenant.test.ts` |
| Migration files applied per schema by a Basalt runner | **Ours** | `migration-files.test.ts` |
| Errors as SQLSTATE (`23505`, `42501`) | Official (the structured error carries the SQLSTATE) | `isolation.test.ts`, `rls.test.ts` |
| Prepared statements skip middleware | Official (documented) | /docs/orm/reference/transactions-and-runtime; **unvalidated** here |
| Includes and joins not filtered by middleware | Official (documented warning) | **Unvalidated** here |
| Migrations with data transforms (`migration.ts` code) applied per schema | **Unvalidated.** The runner applies only the SQL that `migration show` previews, so it must refuse a package with non-SQL operations | Open |
| MySQL | **None**: no Prisma 8 library | /docs/orm/supported-versions |

## 3. Confirmed incompatibilities

These are seen in the tests or in the RC's own types:

1. `pgSchemaClient` (Prisma 7) does not carry over. The schema is in the SQL, not the `search_path` (#503 corrected the docs).
2. A Prisma 8 client cannot be pointed at a schema the contract does not name, at runtime or in middleware.
3. `db migrate` cannot migrate N tenant schemas in one database (`MIGRATION.MARKER_MISMATCH`).
4. `migration plan` needs an explicit origin once files exist (`MIGRATION.PLAN_ORIGIN_UNKNOWN`). A runner passes `--from <previous>`.
5. The RC pins `pg` 8.22.0 and `@types/pg` 8.20.4 exactly. A `pg.Pool` from another `pg` does not typecheck.
6. These Prisma 7 surfaces are gone, and `@basaltkit/prisma` and the stores use them:
   - `$extends` (`tenancyExtension`)
   - batch `$transaction([...])` (RLS today)
   - `$executeRawUnsafe` / `$queryRawUnsafe`
   - `P2xxx` codes (`describeDbError`, `assertMigrated`, five stores)
   - `_prisma_migrations`
   - `migrate deploy/status`, `db push`
   - `take`, `skipDuplicates`, `{ increment }`, `mode: 'insensitive'`, `has`
   - `Date` values (now `Temporal`)

## 4. Risks to tenant isolation and RLS

| Risk | Where | Mitigation in the proposed design |
|---|---|---|
| **Raw SQL reads `public`** when a tenant's client has the contract routing but not the `search_path` (proven in `isolation.test.ts`) | schema-per-tenant | The tenant connection is built by ONE function that sets both, and refuses a schema that is not a plain identifier. A test asserts `current_schema()` per tenant |
| **The contract copy breaks silently** if Prisma changes the contract format | schema-per-tenant | `contractForSchema` throws when `storage.namespaces.public.id` is not where expected. The nightly RC job runs the isolation tests. Move to `namespace unbound` once #30722 is fixed |
| **The tenant setting leaks** between requests if set per session (proven in `rls.test.ts`) | RLS | The tenant is set only with `set_config(…, true)` inside a transaction. The Basalt helper offers no session-level variant, and a test keeps proving the leak so nobody "simplifies" it |
| **Middleware is mistaken for a guarantee.** It does not guard inserts (proven), includes or joins, nor prepared statements (documented) | row-level | Middleware is defence in depth only. RLS (or a schema per tenant) is the guarantee. The Prisma 8 package documents it that way and offers no middleware-only row-level mode |
| **The app role owns the tables** or is a superuser, so RLS is bypassed | RLS | A boot check in the Prisma 8 package: the connected role is neither superuser nor the table owner, and the tenant tables have `FORCE ROW LEVEL SECURITY` |
| **A shared marker** makes Prisma think the central database is at a tenant's hash | migrations | Tenants are migrated by the Basalt runner, which never writes the marker. The central plane uses the official `db migrate` |
| **A half-applied tenant migration** | migrations | Each package runs in one transaction with its ledger row (proven). Packages with non-SQL operations are refused |
| **N clients, N pools** for N tenants | schema-per-tenant | The existing `TenantClientPool` bounds and evicts (unchanged). Pool size per tenant stays small. Load testing is still to do |

## 5. Two architectures

**A. Two packages.** `@basaltkit/prisma` stays Prisma 7. A new package, say `@basaltkit/prisma8`, serves Prisma 8.

**B. One package, a new major.** `@basaltkit/prisma` 5 supports Prisma 8, or both versions behind runtime detection.

| | A: separate package | B: major of the same package |
|---|---|---|
| **Compatibility** | Prisma 7 apps change nothing and keep patches as long as Prisma 7 is supported (18 months after Prisma 8 GA). Prisma 8 apps opt in | A Prisma 8-only major strands Prisma 7 apps on 4.x with no new fixes. A dual major needs optional peers on both `@prisma/client` and `@prisma/orm-postgres`, and runtime detection |
| **API coherence** | Each package documents one Prisma. The Prisma 8 API can follow Prisma 8 (no `tenancyExtension`, middleware instead) | The same names (`tenancyExtension`, `schemaPerTenant.createClient`, `prismaMigrator`) would mean different things per Prisma version, or be removed |
| **Maintenance** | Two packages. The version-agnostic parts are extracted once and shared: `TenantClientPool`, the request lease, `tenantSchema`, `ShardRouter`, `crossTenantSweep`'s orchestration, the plugin wiring. The Prisma-specific parts are separate by nature | One package with two code paths in most modules (extension, RLS, raw SQL, errors, migrate, status, sync), tested twice, entangled |
| **Experience** | One import per Prisma version, and `create-basalt` picks it. Docs pages split by version | One import, but a matrix of "works on 7 / works on 8" in every option's docs |
| **Impact on the four apps** | None until each app chooses to move. lexfirma, mukanda and Corredor can move one by one. producer-basalt (MySQL) stays on Prisma 7 | A major the apps must take to stay current, whether or not they move to Prisma 8 |
| **Stability of the stable line** | Experimental Prisma 8 code never touches `@basaltkit/prisma` | Prisma 8 code ships inside the stable package |

**The stores** (`auth-prisma`, `teams-prisma` and the other ten) type their client structurally and have no Prisma dependency. Their Prisma 8 versions do not need new packages. A `/prisma8` subpath per store package (`@basaltkit/auth-prisma/prisma8`) keeps one package per domain, adds no dependency, and leaves the root export (Prisma 7) untouched.

## 6. Recommendation

**Choose A, after Prisma 8 GA:**

1. **Now (no runtime change):**
   - Keep the harness and the nightly RC job.
   - Extend it as Prisma changes: `unbound` fixed, a per-schema marker, data-transform migrations.
2. **Extract the version-agnostic core** into an internal shared module, as a refactor of `@basaltkit/prisma` with identical exports and the full existing test suite as the safety net. This is the only step that touches the stable package, and it changes no behaviour.
3. **After GA,** build `@basaltkit/prisma8`:
   - `schemaPerTenant` with the tested design: a per-tenant contract plus the `search_path` from one guarded function, and the Basalt migration runner;
   - row-level tenancy as RLS plus `set_config(…, true)` per transaction, with middleware filters as defence in depth;
   - errors by SQLSTATE.

   Publish it as `0.x` until one app has run on it.
4. **Then:**
   - store `/prisma8` subpaths, `create-basalt --prisma8`, generator templates and `@basaltkit/deploy` (`contract emit`, `db migrate`);
   - docs split by Prisma version.
5. **When #30722 is fixed,** re-run `unbound.test.ts`. If late binding works end to end, including migrations, prefer it over the contract copy: it is Prisma's own mechanism.

That keeps Prisma 7 untouched, keeps experimental code out of stable packages, and makes the Prisma 8 path one opt-in package with the isolation guarantees proven by tests.

## 7. Is a proposal to Prisma needed?

Yes, and it is narrow. The tests show two limitations of the API itself, beyond the bug Prisma already tracks:

1. **No supported way to choose the schema per client.** #30722 covers a bug in the experimental `unbound` path, not the absence of a supported option.
2. **Migrations cannot track several schemas in one database.** ADR 021's per-schema marker is not implemented, and `db update` treats an `unbound` namespace as externally controlled.

The draft is in Appendix A **for review only**. It is not filed.

## 8. Open questions

- Data-transform migrations per schema (`migration.ts` with TypeScript operations): refuse, or run them per tenant?
- Prepared statements and middleware filters: test the documented bypass.
- Include/join filtering: test the documented gap.
- Pool sizing and eviction under N tenants on Prisma 8: load test.
- `Temporal` values across the stores: a shared codec layer, or per store?

---

## Appendix A — draft proposal to the Prisma team (for review, not filed)

> **Title:** Schema-per-tenant on PostgreSQL: a supported way to bind a client (and migrations) to a schema at runtime
>
> **Context.** We maintain a framework (BasaltKit) whose apps run one PostgreSQL schema per tenant in one database, on Prisma 7 today. We are preparing Prisma 8 support and tested the RC (`@prisma/orm-postgres` 8.0.0-rc.20, CLI 8.0.0-rc.27) against PostgreSQL 16.
>
> **What we found.**
> 1. The ORM qualifies every statement with the contract namespace (`INSERT INTO "public"."Project"`). A connection's `search_path` does not change it, and `postgres()` has no schema option.
> 2. `namespace unbound` would solve the runtime part, but it is qualified as `"__unbound__"` after `contract.json` is loaded (#30722). `db update` also plans no DDL for an unbound namespace ("effective control 'external'").
> 3. A middleware cannot redirect a query to a schema the contract does not declare (`RUNTIME.NAMESPACE_UNKNOWN`).
> 4. `db migrate` for a second schema in the same database fails with `MIGRATION.MARKER_MISMATCH`, because `prisma_contract.marker` is one row per space per database. ADR 021 describes a per-schema marker locator, but it does not seem to be implemented.
>
> **Minimal reproduction** (PostgreSQL 15+, empty database):
> ```prisma
> // use prisma-8
> model Project {
>   id   String @id
>   name String
> }
> ```
> ```sh
> prisma contract emit && prisma db init --yes
> psql -c 'CREATE SCHEMA tenant_a; CREATE TABLE tenant_a."Project" (LIKE public."Project" INCLUDING ALL);'
> ```
> ```ts
> import pg from 'pg'
> import postgres from '@prisma/orm-postgres/runtime'
> import { contractFromJson } from '@prisma/orm-postgres/static'
> import contract from './contract.json' with { type: 'json' }
>
> const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=tenant_a' })
> const db = postgres({ contract: contractFromJson(contract), pg: pool })
> await db.orm.public.Project.create({ id: '1', name: 'tenant a' })
> // the row is in public."Project", not tenant_a."Project"
> ```
> For migrations: wrap the same model in `namespace tenant_a { … }`, run `prisma migration plan --name init`, then `prisma db migrate`. It fails with `MIGRATION.MARKER_MISMATCH`, because the marker holds the `public` contract's hash.
>
> **What we do today.** We copy the contract and set `storage.namespaces.public.id` to the tenant's schema. That routes every statement correctly, but it relies on the contract's internal shape. For migrations we apply the SQL of each planned package per schema ourselves, with our own ledger.
>
> **What would let us drop both workarounds,** in order of preference:
> 1. A supported runtime binding: `postgres({ contract, url, namespaces: { public: 'tenant_a' } })`, or `contract.withNamespace('public', 'tenant_a')`. It should keep the generated types (`db.orm.public.*`).
> 2. `namespace unbound` working end to end: runtime (#30722) and migrations, either with DDL emitted unqualified for the connection's `search_path`, or a marker per schema (ADR 021's locator).
>
> We are happy to test patches against our harness: 27 tests covering isolation, RLS and migrations against PostgreSQL.
