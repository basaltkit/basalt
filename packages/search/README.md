<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/search

Full-text search for Basalt: indexes and searches documents **per tenant**, with a typed API and an interchangeable driver — **in-memory** for development/testing and, for production, **Meilisearch** (built in), **Postgres full-text** (`@basaltkit/search-postgres`) or **Elasticsearch / OpenSearch** (`@basaltkit/search-elasticsearch`). You need this module when you want to give users a fast, relevant search box over their data (notes, projects, customers…).

## What this module solves

Searching well is more than a `WHERE ... LIKE '%text%'`: you need **relevance** (the best results first), **prefix** matching, and **tenant isolation** (customer A never sees customer B's data). This module gives you that with:

- **Typed indexes** — declare once which fields are searchable and filterable.
- **Guaranteed tenant isolation** — every search is scoped to `tenantId`; a result never "leaks" between tenants. Inside a tenant context an explicit `tenantId` must match it (otherwise `SearchTenantMismatchError`, 403), so client input can never widen a query or plant a document elsewhere.
- **Interchangeable driver** — `MemorySearchDriver` (no services, for dev/test), `MeilisearchDriver` (production, built in), and the separate driver packages `PostgresSearchDriver` and `ElasticsearchDriver`. Your code doesn't change when you switch.
- **Automatic indexing** — hooks into domain events (created/updated/deleted) and the index keeps itself up to date.

## Installation

```bash
pnpm add @basaltkit/search
```

Depends only on `@basaltkit/core`. `MemorySearchDriver` works with nothing installed; for production, point `MeilisearchDriver` at a Meilisearch server, or install one of the driver packages (see [Drivers](#drivers)).

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { searchPlugin, SEARCH, defineIndex } from '@basaltkit/search'

const app = await createApp({
  plugins: [
    searchPlugin({
      indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
    }),
  ],
}).boot()

const search = app.container.get(SEARCH)

// index (the document carries the tenantId)
await search.index('notes', { id: '1', tenantId: 'acme', title: 'Hello world', body: 'first note', folder: 'inbox' })

// search (the tenant comes from the request context, or you pass it explicitly)
const result = await search.search('notes', 'hello', { tenantId: 'acme', filters: { folder: 'inbox' } })
console.log(result.hits) // [{ id: '1', score, document }]
console.log(result.total)
```

## Automatic indexing (hooks → index)

Instead of indexing by hand everywhere, wire domain events to the index — and it keeps itself up to date:

```ts
import { searchPlugin, defineIndex, syncRule } from '@basaltkit/search'

searchPlugin({
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'] })],
  sync: [
    syncRule({
      hook: 'note:created', // or note:updated
      index: 'notes',
      document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body }),
    }),
    syncRule({
      hook: 'note:deleted',
      index: 'notes',
      remove: (p) => ({ tenantId: p.tenantId, id: p.noteId }),
    }),
  ],
})
```

`syncRule` type-checks against the hook's payload. Return `null` from `document`/`remove` to skip an event. Add `backfill` to the rule to make the index rebuildable — see below.

## Who may see a hit (`authorize`)

A driver filters by the fields you declared `filterable` and nothing else. Where visibility depends on a policy — a confidential record is visible only to the people assigned to it — pass `authorize` and the package applies it to every page:

```ts
const page = await search.search('matters', q, {
  limit: 20,
  authorize: async (hits) => hits.filter((h) => allowed.has(h.id)),
})
```

The hook runs **after** the driver, which is what lets the package keep asking until your page is full — the thing a caller cannot do from outside without guessing an over-fetch factor. `offset` counts authorized hits, so page two continues where page one ended, and `maxScan` bounds the work (default: 20 pages, floor 200).

Do **not** copy the ACL into the index instead. It is faster, and it makes the index a second copy of an access rule: remove someone from a confidential record and the database changes while the index does not, so search keeps showing it to them until somebody reindexes. A stale index gives an old result; a stale ACL gives an unauthorized one.

The result's `total` is then the authorized count, and `totalExact` says whether it is the whole truth — `false` means "at least this many", because the scan stopped at its budget.

Callers without the hook are untouched: one driver call, same behaviour, same cost.

## Rebuilding an index (`backfill` + `reindex`)

A rule fed by events knows only what was created after the rule existed, so adding search to data you already have gives a box that returns nothing for everything old. Give the rule a `backfill` and one declaration serves both directions:

```ts
syncRule({
  hook: 'note:created',
  index: 'notes',
  document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title }),
  backfill: async function* () {
    for (let page = 0; ; page++) {
      const rows = await notes.page(page, 500)
      if (rows.length === 0) return
      yield rows.map((note) => ({ note, tenantId: note.tenantId }))   // the same payload the hook carries
    }
  },
})

await search.reindex('notes')   // → number of documents written
```

`backfill` yields **hook payloads**, not rows, so the same `document` function maps both. A second mapping written by hand is the drift this prevents: let it disagree and the same search returns different things depending on whether a record predates the last rebuild. Every row is mapped and validated **before** the index is cleared (two walks over `backfill`, memory bounded by one page), so a rebuild that would fail leaves the old index in place instead of an empty one; rows that change between the walks can still fail the second — rerun then. The index is then cleared, not appended to — a rebuild that appends leaves documents for records that no longer exist — and an index whose rules have no `backfill` raises, rather than reporting a rebuild that did nothing.

A rebuild covers every tenant, so it never takes the tenant from the context it runs in: in a multi-tenant app `document` must return `tenantId`, and a row without one throws `TenantRequiredError` whenever `@basaltkit/tenancy` is registered or a tenant context is active. Only a single-tenant app with no context tenant files tenant-less rows under `SINGLE_TENANT_SCOPE`. `reindex()` clears the **whole** index, so `backfill` must yield every tenant's records — never call it once per tenant (e.g. inside `tenancy.run`), or each call wipes the others.

## How relevance works (in-memory driver)

`MemorySearchDriver` tokenizes the searchable fields and scores by **term frequency** with **prefix** matching (`qui` matches `quick`). It requires **all** query terms to be present (AND semantics), sorts by score, and only searches the fields declared in `fields`. It's deterministic and good enough for development; in production Meilisearch provides real relevance (typo-tolerance, stemming, etc.).

## Production with Meilisearch

```ts
import { searchPlugin, MeilisearchDriver, defineIndex } from '@basaltkit/search'

searchPlugin({
  driver: new MeilisearchDriver({ host: 'http://localhost:7700', apiKey: process.env.MEILI_KEY }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

The driver talks directly to Meilisearch's REST API (no SDK). Each document gets a composite primary key (`_pk`), so ids never collide across tenants; and **every search is filtered by `tenantId`**, guaranteeing isolation. `defineIndex(...).filterable` is automatically declared as a filterable attribute in Meilisearch.

## Production with Postgres or Elasticsearch

No separate search service? `@basaltkit/search-postgres` uses Postgres' native full-text search (`tsvector` / `ts_rank`) on the `pg` client you already have:

```ts
import { PostgresSearchDriver } from '@basaltkit/search-postgres'

searchPlugin({ driver: new PostgresSearchDriver({ client: pgPool }), indexes: [/* … */] })
```

For large-scale relevance, `@basaltkit/search-elasticsearch` targets the Elasticsearch 8.x / OpenSearch 2.x REST API directly (no SDK):

```ts
import { ElasticsearchDriver } from '@basaltkit/search-elasticsearch'

searchPlugin({
  driver: new ElasticsearchDriver({ node: process.env.ES_NODE!, apiKey: process.env.ES_API_KEY }),
  indexes: [/* … */],
})
```

Both keep the same guarantee as the built-in drivers: **every query is constrained to the tenant**.

## API reference

### `searchPlugin(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `driver` | `SearchDriver` | `MemorySearchDriver` | Search backend. |
| `indexes` | `IndexDefinition[]` | `[]` | Indexes to register on startup. A listed index only accepts `filters` on its `filterable` fields. |
| `sync` | `SyncRule[]` | `[]` | Hook → index rules (use `syncRule(...)`). |
| `maxLimit` | `number` | `1000` | Largest `limit` one `search()` may ask for; above it throws `SearchPaginationError`. |

Registers the `SEARCH` token (`Search`).

### `class Search`

| Method | Description |
|---|---|
| `index(indexName, document)` | Indexes/updates a document (carries `id` and `tenantId`). |
| `bulk(indexName, documents)` | Indexes several. |
| `remove(indexName, id, tenantId?)` | Removes a document (tenant from context if omitted). |
| `search(indexName, q, options?)` | Searches. `options`: `tenantId?`, `filters?`, `limit?`, `offset?`, `authorize?`, `maxScan?`. Validated first — see below. |
| `reindex(indexName)` | Rebuilds the index from its rules' `backfill`, through their own `document`. Validates every row, then clears and writes; returns how many documents were written. Throws if no rule declares the index, none has a `backfill`, or a row has no `tenantId` where a tenant could exist. |

`search()` validates its input before any driver runs (each a `400`):

- `limit`/`offset` must be non-negative integers and `limit` ≤ `maxLimit` (default `1000`, `searchPlugin({ maxLimit })`) — `SearchPaginationError` (`SEARCH_INVALID_PAGINATION`).
- On an index listed in `searchPlugin({ indexes })` (or `new Search({ indexes })`), a filter may only name a `filterable` field or `tenantId` — `SearchFilterNotFilterableError` (`SEARCH_FILTER_NOT_FILTERABLE`). Indexes not listed keep passing any field to the driver.
- A filter value must be a string, a finite number, a boolean, or a flat array of those; `null`/`undefined` are refused rather than dropped (dropping would widen the result) — `SearchFilterValueError` (`SEARCH_INVALID_FILTER_VALUE`). `MeilisearchDriver` repeats this check, since it splices values into its filter DSL.

Without an explicit `tenantId`, `search`/`remove` use `ctx().tenant.id`; if there's no tenant, they throw `TenantRequiredError` — **only when `@basaltkit/tenancy` is registered**. An app without it has no tenant dimension: every document lands in `SINGLE_TENANT_SCOPE` (`'@single'`, a sentinel outside the tenant-id grammar; a tenant carrying it — from the context, an argument, a document or a `reindex()` row — is refused with `SearchTenantReservedError`, `SEARCH_TENANT_RESERVED`, 400).

> **Upgrading from 1.x (single-tenant data):** the scope used to be `'default'`, a valid tenant id — a tenant named `default` found, overwrote and removed the single-tenant documents. The index is derived data: rebuild it once (`search.reindex(name)` for rules with a `backfill`, or re-run your indexing). With `@basaltkit/search-postgres` you can re-key in place instead: `UPDATE basalt_search SET tenant_id = '@single', document = jsonb_set(document, '{tenantId}', '"@single"') WHERE tenant_id = 'default'`. Meilisearch and Elasticsearch derive their primary key from the tenant, so there only a rebuild works. Skip it if `default` was ever a real tenant.

### `defineIndex({ name, fields, filterable? })`

Declares an index: `fields` are searchable (full-text), `filterable` are usable in `filters` (`tenantId` is always filterable).

### Drivers

| Driver | Package | Use |
|---|---|---|
| `MemorySearchDriver` | `@basaltkit/search` | In-process, dev/test. |
| `MeilisearchDriver({ host, apiKey?, fetch? })` | `@basaltkit/search` | Production; `fetch` is injectable for tests. |
| `PostgresSearchDriver({ client, table?, language? })` | `@basaltkit/search-postgres` | Production on Postgres full-text (`tsvector`/`ts_rank`, GIN index) — no extra infrastructure. |
| `ElasticsearchDriver({ node, apiKey? \| username?+password?, indexPrefix?, fetch? })` | `@basaltkit/search-elasticsearch` | Production on Elasticsearch 8.x / OpenSearch 2.x (`multi_match` relevance). |

Any object implementing the `SearchDriver` interface plugs in the same way.

## How it connects to other modules

- **`@basaltkit/core`** — `createApp`, tokens, hooks (which automatic sync consumes), and the context `tenantId` comes from.
- **`@basaltkit/tenancy`** — places `tenant` in the context; with it active, `search.search('notes', q)` already knows the tenant.
- **`@basaltkit/events`** — emits the domain events that feed `sync`.
