<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/search-postgres

**PostgreSQL full-text search** driver for [`@basaltkit/search`](https://www.npmjs.com/package/@basaltkit/search): uses Postgres's `tsvector`/`tsquery`/`ts_rank`, with tenant isolation. You need this module when you already have Postgres and want relevant search **without** an external service (Meilisearch/Elastic).

## What this module solves

Many SaaS apps already run on Postgres. Postgres has real full-text search (stemming, ranking) via `tsvector`. This driver connects `@basaltkit/search` to that: a table indexed by (index, tenant, id), a `tsvector` with a GIN index, and `ts_rank` searches always scoped to the tenant.

## Installation

```bash
pnpm add @basaltkit/search-postgres @basaltkit/search pg
```

`pg` is the client you pass to the driver (a `Pool` or `Client`).

## Usage

```ts
import { Pool } from 'pg'
import { searchPlugin, defineIndex } from '@basaltkit/search'
import { PostgresSearchDriver } from '@basaltkit/search-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

searchPlugin({
  driver: new PostgresSearchDriver({ client: pool }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

`register` (called by `searchPlugin` at boot) creates the `basalt_search` table and the GIN index. `index`/`search`/`remove`/`clear` work like any other `@basaltkit/search` driver.

## How it works

- **One table** for all indexes: `(idx, tenant_id, id, document jsonb, tsv tsvector)`, with a GIN index on `tsv`.
- When indexing, the document's searchable fields feed `to_tsvector(<language>, …)` (default `english`, with stemming).
- When searching, `tsv @@ plainto_tsquery(...)` filters and `ts_rank` orders (under row-level security this needs [one extra step](#row-level-security-the-gin-index-trap), or the index is not used); **every** query has `tenant_id = $tenant`, so results never leak between tenants. `filters` become `document->>'field' = $value` conditions (or `= ANY(...)` for arrays).

## Row-level security: the GIN-index trap

If the search table is protected by PostgreSQL row-level security — which Basalt recommends for tenant tables (`rlsPolicySql`, `tenancyExtension({ rls: true })`) — **the GIN index silently stops being used**, and every search becomes a sequential scan over every tenant's documents.

Why: PostgreSQL may only evaluate a qualifier *before* a row-security policy if that qualifier is `LEAKPROOF` (otherwise its error messages could leak the contents of rows the policy hides). The text-search operator `@@` is not leakproof. So for a role the policy applies to, `tsv @@ plainto_tsquery(…)` can never become an index condition — it is demoted to a filter applied *after* the policy, and the planner falls back to `Seq Scan`. Nothing warns you; a development dataset never reveals it; it shows up when one tenant's corpus gets big.

Measured on 30 200 documents in one table (30 000 for the searching tenant, 200 for another), PostgreSQL 16:

```text
-- table owner, no policy in the way
->  Bitmap Heap Scan on basalt_search                     (actual rows=3)
      Recheck Cond: (tsv @@ 'zarbalux'::tsquery)
      ->  Bitmap Index Scan on basalt_search_tsv_idx      (actual rows=203)
Execution Time: 4.920 ms      -- warm: ~0.6 ms

-- application role (NOSUPERUSER NOBYPASSRLS), exactly the same SQL
->  Seq Scan on basalt_search                             (actual rows=3)
      Filter: ((tenant_id = 'acme') AND (idx = 'notes') AND (tsv @@ 'zarbalux'::tsquery))
      Rows Removed by Filter: 30197
Execution Time: 14.702 ms     -- ~24x slower warm, and it grows with the corpus
```

### The recipe

Generate a `SECURITY DEFINER` search function with [`rlsSearchFunctionSql`](https://github.com/basaltkit/basalt/tree/main/packages/prisma#full-text-search-under-rls-the-gin-index-trap) from `@basaltkit/prisma` (migration-time only — nothing is added to this package's runtime dependencies), and point the driver at it:

```ts
// migration, once — run as a role that bypasses the table's RLS
import { rlsSearchFunctionSql } from '@basaltkit/prisma'

rlsSearchFunctionSql({
  name: 'basalt_search_scoped',
  table: 'basalt_search',
  vectorColumn: 'tsv',
  partitionColumn: 'idx',                         // the index name column
  filterColumn: 'document',                       // what `filters` match on
  columns: [{ name: 'document', type: 'jsonb' }],
  role: 'app',                                    // the role the app connects as
  owner: 'app_owner',                             // BYPASSRLS / superuser
  maxRows: 100,
})
```

```ts
// runtime
new PostgresSearchDriver({ client: pool, searchFunction: 'basalt_search_scoped' })
```

Text queries now go through the function and the index is back:

```text
SELECT * FROM basalt_search_scoped('zarbalux', 'notes', NULL, 20, 0);
->  Bitmap Heap Scan on basalt_search t                   (actual rows=3)
      Filter: ((idx = 'notes') AND (tenant_id = current_setting('app.tenant_id', true)))
      ->  Bitmap Index Scan on basalt_search_tsv_idx      (actual rows=203)
Execution Time: 1.850 ms      -- warm: ~0.6 ms
```

Isolation is preserved, and it fails closed:

- The function takes **no tenant parameter**. It reads the tenant from `current_setting('app.tenant_id', true)` — the very setting the RLS policy reads, and the one `tenancyExtension({ rls: true })` / `tenantTransaction` set on the connection. So run searches inside the tenant's transaction, as you already do for every other query.
- **No tenant in the setting → no rows.** `current_setting(…, true)` is `NULL` when unset and `tenant_id = NULL` is never true. It can never degrade into "all tenants".
- The driver still **verifies**: every row the function returns is checked against the `tenantId` of the query, and a mismatch throws instead of being returned. A connection left on another tenant, or a function generated with a different `setting` than the policy, is caught rather than served.
- `p_limit` is clamped inside the function, `filters` are applied inside it (so the cap and the returned `total` are honest), `EXECUTE` is revoked from `PUBLIC`, and `search_path` is pinned.
- `searchFunction` only affects **text** queries. A query with no `q` is plain equality on `(idx, tenant_id)`, which *is* leakproof, so RLS leaves the primary key alone and the driver keeps querying the table directly.

> [!WARNING]
> Do **not** "fix" the plan with `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF`. It is the shortcut every search result suggests and it does restore the index — by weakening the leakproof rule **database-wide**, for every table and every policy. A carefully crafted `@@` then becomes a side channel for probing rows a policy is hiding. The trade is a local speed-up for a global loss of isolation.

If the search table is **not** under RLS, none of this applies — leave `searchFunction` unset.

## Testable without a database

The `pg` client is **injectable**, so SQL construction can be tested with a fake — no Postgres needed:

```ts
new PostgresSearchDriver({ client: fakePgClient })
```

## Options

| Option | Default | Description |
|---|---|---|
| `client` | — (required) | Already-connected `pg` `Pool`/`Client`. |
| `table` | `basalt_search` | Table shared by all indexes. May be schema-qualified (`app.search`); the GIN index is then named with the separator flattened (`app_search_tsv_idx`), because Postgres does not allow schema-qualified index names. |
| `language` | `english` | Text-search configuration (stemming/stop-words). |
| `searchFunction` | — | Name of a `SECURITY DEFINER` search function (`'fn'`, `'schema.fn'` or `{ name, schema }`) to route **text** queries through. Required when the table is under row-level security, otherwise the GIN index is not used — see [the trap](#row-level-security-the-gin-index-trap). |

## How it connects to other modules

- **`@basaltkit/search`** — this is a driver for that package; the API (`defineIndex`, `search`, hook-based sync) comes from there.
- Sibling drivers: `MemorySearchDriver` (dev) and `MeilisearchDriver` (in search core).
