# @machize/search-postgres

**PostgreSQL full-text search** driver for [`@machize/search`](https://www.npmjs.com/package/@machize/search): uses Postgres's `tsvector`/`tsquery`/`ts_rank`, with tenant isolation. You need this module when you already have Postgres and want relevant search **without** an external service (Meilisearch/Elastic).

## What this module solves

Many SaaS apps already run on Postgres. Postgres has real full-text search (stemming, ranking) via `tsvector`. This driver connects `@machize/search` to that: a table indexed by (index, tenant, id), a `tsvector` with a GIN index, and `ts_rank` searches always scoped to the tenant.

## Installation

```bash
pnpm add @machize/search-postgres @machize/search pg
```

`pg` is the client you pass to the driver (a `Pool` or `Client`).

## Usage

```ts
import { Pool } from 'pg'
import { searchPlugin, defineIndex } from '@machize/search'
import { PostgresSearchDriver } from '@machize/search-postgres'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

searchPlugin({
  driver: new PostgresSearchDriver({ client: pool }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

`register` (called by `searchPlugin` at boot) creates the `machize_search` table and the GIN index. `index`/`search`/`remove`/`clear` work like any other `@machize/search` driver.

## How it works

- **One table** for all indexes: `(idx, tenant_id, id, document jsonb, tsv tsvector)`, with a GIN index on `tsv`.
- When indexing, the document's searchable fields feed `to_tsvector(<language>, …)` (default `english`, with stemming).
- When searching, `tsv @@ plainto_tsquery(...)` filters and `ts_rank` orders; **every** query has `tenant_id = $tenant`, so results never leak between tenants. `filters` become `document->>'field' = $value` conditions (or `= ANY(...)` for arrays).

## Testable without a database

The `pg` client is **injectable**, so SQL construction can be tested with a fake — no Postgres needed:

```ts
new PostgresSearchDriver({ client: fakePgClient })
```

## Options

| Option | Default | Description |
|---|---|---|
| `client` | — (required) | Already-connected `pg` `Pool`/`Client`. |
| `table` | `machize_search` | Table shared by all indexes. |
| `language` | `english` | Text-search configuration (stemming/stop-words). |

## How it connects to other modules

- **`@machize/search`** — this is a driver for that package; the API (`defineIndex`, `search`, hook-based sync) comes from there.
- Sibling drivers: `MemorySearchDriver` (dev) and `MeilisearchDriver` (in search core).
