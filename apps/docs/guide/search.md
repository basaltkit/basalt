# Search

`@basaltkit/search` gives your app full-text search that is **tenant-scoped by
construction** — every query is forced to the caller's tenant, so results never
leak between tenants. It ships an in-memory driver for dev/test and a
Meilisearch driver for production, behind one API.

[[toc]]

## Setup

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
```

`defineIndex` declares which fields are searchable (`fields`) and which can be
filtered (`filterable`); `tenantId` is always filterable.

## Index and query

```ts
// index — the document carries its id and tenantId
await search.index('notes', { id: '1', tenantId: 'acme', title: 'Hello world', body: 'first note', folder: 'inbox' })

// query — tenant from options, or from the request context
const result = await search.search('notes', 'hello', { tenantId: 'acme', filters: { folder: 'inbox' } })
result.hits // [{ id, score, document }] — most relevant first
result.total
```

Inside a request, the tenant comes from `ctx().tenant` automatically:

```ts
import { z } from 'zod'
import { route } from '@basaltkit/fastify'
import { SEARCH } from '@basaltkit/search'
import { app } from './app.js'

const search = app.container.get(SEARCH)

export const searchNotes = route({
  method: 'GET',
  url: '/search',
  query: z.object({ q: z.string() }),
  handler: ({ query }) => search.search('notes', query.q), // tenant implicit
})
```

If no tenant can be determined, `search`/`remove` throw `TenantRequiredError`.

To seed an index (backfill, migration), `bulk` upserts many documents at once —
each still carries its own `tenantId`:

```ts
await search.bulk('notes', [
  { id: '1', tenantId: 'acme', title: 'Hello world', body: 'first note' },
  { id: '2', tenantId: 'acme', title: 'Release plan', body: 'ship it' },
])
```

## Relevance (in-memory driver)

The `MemorySearchDriver` tokenizes the searchable fields and scores by **term
frequency** with **prefix matching** (`qui` matches `quick`). It requires every
query term to match (**AND** semantics) and searches only the declared fields.
It's deterministic and dependency-free — ideal for dev and tests. Production
relevance (typo tolerance, stemming) is the Meilisearch driver's job.

## Keeping the index in sync

Wire domain hooks to the index and it maintains itself:

```ts
import { searchPlugin, defineIndex, syncRule } from '@basaltkit/search'

searchPlugin({
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'] })],
  sync: [
    syncRule({ hook: 'note:created', index: 'notes',
      document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body }) }),
    syncRule({ hook: 'note:updated', index: 'notes',
      document: (p) => ({ id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body }) }),
    syncRule({ hook: 'note:deleted', index: 'notes',
      remove: (p) => ({ tenantId: p.tenantId, id: p.noteId }) }),
  ],
})
```

`syncRule` type-checks against the hook's payload. Return `null` to skip an
event.

## Production with Meilisearch

```ts
import { searchPlugin, MeilisearchDriver, defineIndex } from '@basaltkit/search'

searchPlugin({
  driver: new MeilisearchDriver({ host: process.env.MEILI_HOST!, apiKey: process.env.MEILI_KEY }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

The driver talks to the Meilisearch REST API directly (no SDK). Each document
gets a compound primary key so ids never collide across tenants, and **every
search is constrained with a `tenantId` filter** — the same isolation guarantee
as the in-memory driver. Your `filterable` fields are declared as Meilisearch
filterable attributes automatically.

## Already on Postgres?

If you'd rather not run a separate search service, `@basaltkit/search-postgres`
uses Postgres' native full-text search (`tsvector` / `ts_rank`) — bring your
`pg` client:

```ts
import { PostgresSearchDriver } from '@basaltkit/search-postgres'
searchPlugin({ driver: new PostgresSearchDriver({ client: pgPool }), indexes: [/* … */] })
```

It creates one GIN-indexed table for all indexes, feeds the searchable fields
into `to_tsvector`, ranks with `ts_rank`, and constrains every query to the
tenant — the same isolation guarantee, no extra infrastructure.

## Elasticsearch / OpenSearch

For large-scale relevance, `@basaltkit/search-elasticsearch` targets the
Elasticsearch 8.x / OpenSearch 2.x REST API directly (no SDK), with an injectable
`fetch`:

```ts
import { ElasticsearchDriver } from '@basaltkit/search-elasticsearch'

searchPlugin({
  driver: new ElasticsearchDriver({ node: process.env.ES_NODE!, apiKey: process.env.ES_API_KEY }),
  indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })],
})
```

`register` maps searchable fields as `text` (with a `.keyword` sub-field) and
filterable fields as `keyword`; `search` uses `multi_match` with an exact
`track_total_hits`. Documents get a compound `<tenantId>:<id>` id and **every
search carries a mandatory `tenantId` filter** — the same isolation guarantee as
every other driver.

## Filters and paging

```ts
await search.search('notes', 'report', {
  tenantId: 'acme',
  filters: { folder: 'work' },        // exact match; an array means "any of"
  limit: 20,
  offset: 40,
})
```

## Reference

| API | Purpose |
| --- | --- |
| `defineIndex({ name, fields, filterable? })` | Declare an index. |
| `searchPlugin({ driver?, indexes?, sync? })` | Register the service, indexes and sync rules. |
| `SEARCH` | DI token → the `Search` service. |
| `search.index/bulk/remove/search` | Index, bulk-index, remove, query. |
| `MemorySearchDriver` · `MeilisearchDriver` | Dev/test and production backends. |

See the [notes SaaS cookbook](/cookbook/notes-saas) for search in a full app.
