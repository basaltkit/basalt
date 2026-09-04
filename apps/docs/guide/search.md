# Search

`@basaltkit/search` gives your app full-text search that is **tenant-scoped by
construction** — every query is forced to the caller's tenant, so results never
leak between tenants. In an app with no `tenancyPlugin` there is no tenant to
scope to: `tenantId` becomes optional on both `index()` and `search()`, and both
resolve to one internal `'default'` scope, so they always agree
(see [Beyond SaaS](/guide/beyond-saas)). It ships an in-memory driver for dev/test and a
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

`document` upserts a document (on create/update); `remove` deletes one. Return
`null` to skip an event.

### Emit the hook from your code

`sync` only *reacts* — something has to **emit** the hook on the core `HookBus`.
Pass it to your service (plugins receive it in `register`/`boot`) and emit after
the write:

```ts
// post.plugin.ts — hand the HookBus to the service
register({ container, hooks }) {
  container.singleton(POST_SERVICE, (c) => new PostService(c.get(POST_REPOSITORY), hooks))
}

// post.service.ts — emit after persisting
async create(input) {
  const post = await this.repository.create(input)
  await this.hooks.emit('post:created', { tenantId: ctx().tenant?.id ?? 'demo', id: post.id, name: post.name })
  return post
}
```

### Type the hook payloads

`BasaltHooks` has an index signature (`[hook: string]: unknown`), so a hook works
at runtime **without** declaring it. But then its payload is `unknown`, and the
`document` / `remove` mappers won't type-check (`p.id` errors). Declare the
payloads once — in any file that's part of the compilation — to get full type
safety on both `emit` and `syncRule`:

```ts
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'post:created': { tenantId: string; id: string; name: string }
    'post:updated': { tenantId: string; id: string; name: string }
    'post:deleted': { tenantId: string; id: string }
  }
}
```

::: tip Not mandatory to run
The declaration isn't required for the code to run — it's what makes `emit()` and
the `syncRule` mappers type-safe. Skip it and the payload is `unknown` (you'd
cast, or annotate each mapper inline).
:::

## Who may see a hit

A driver filters by the fields you declared `filterable`, and nothing else. In a
product where visibility depends on a policy — a confidential matter is visible
only to the people assigned to it — that leaves search as the one surface with
no answer.

```ts
const page = await search.search('matters', q, {
  limit: 20,
  authorize: async (hits) => {
    const rows = await matters.findMany({ id: { in: hits.map((h) => h.id) } })
    const allowed = new Set(
      (await Promise.all(rows.map(async (m) => ((await gate.can(user, 'matter:read', m)) ? m.id : null))))
        .filter(Boolean),
    )
    return hits.filter((h) => allowed.has(h.id))
  },
})
```

::: danger Do not put the ACL in the index
Copying `assigneeIds` and `confidential` into the document and filtering there
is faster, and it makes the index a **second copy of an access rule**. Remove
someone from a confidential matter: the database changes, the index does not,
and search keeps showing it to them until somebody reindexes.

A stale index gives an old result. A stale ACL gives an unauthorized one.
:::

The hook runs after the driver, which is what lets the package keep asking until
your page is full — the thing you cannot do from outside without guessing an
over-fetch factor. `offset` counts authorized hits, so page two continues where
page one ended.

| Option | What it does |
| --- | --- |
| `authorize` | Returns the hits the caller may see, in the order given. Must not reorder — relevance is the driver's to decide |
| `maxScan` | How many driver rows a search may scan before giving up. Default: 20 pages, floor 200 |
| `totalExact` *(on the result)* | Whether `total` is the whole truth. A driver's total counts rows the caller may not see, and rendering it would put "42 results" above three rows |

Callers without the hook are untouched: one driver call, same behaviour.

## Rebuilding an index

A rule fed by events knows only what was created after the rule existed. Add
search to data you already have and you get a box that returns nothing for
everything old — and an empty result is indistinguishable from "there is none".

Give the rule a `backfill` and the same declaration works in both directions:

```ts
syncRule({
  hook: 'matter:opened',
  index: 'matters',
  document: ({ matter }) => ({ id: matter.id, tenantId: matter.tenantId, number: matter.number }),
  backfill: async function* () {
    for (let page = 0; ; page++) {
      const rows = await matters.page(page, 500)
      if (rows.length === 0) return
      yield rows.map((matter) => ({ matter }))   // the same payload the hook carries
    }
  },
})

await search.reindex('matters')
```

`backfill` yields **hook payloads**, not rows, so one `document` function serves
both paths. A second mapping written by hand is the drift this prevents: let it
disagree and the same search returns different things depending on whether a
record predates the last rebuild.

The index is cleared first — a rebuild that appends leaves documents for records
that no longer exist — and an index whose rules have no `backfill` raises,
rather than reporting a rebuild that did nothing.

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

`table` may be schema-qualified (`table: 'app.search'`); the GIN index is named
with the separator flattened (`app_search_tsv_idx`), because Postgres does not
allow a schema-qualified index name. It still lands in the table's own schema.

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
`track_total_hits`. Documents get a compound `<tenantId>:<id>` id — **each
segment percent-encoded**, so a `:` inside a tenant id or document id can't make
tenant `a:b` + id `c` collide with tenant `a` + id `b:c` — and **every search
carries a mandatory `tenantId` filter**, the same isolation guarantee as every
other driver. Plain UUID/slug ids are unchanged by the encoding.

::: warning Auth: password vs API key
`username` + `password` use HTTP **Basic auth**. `apiKey` sends the header
`Authorization: ApiKey <key>` and expects an **API key** from
`POST /_security/api_key` — not your user's password. Passing the password as
`apiKey` returns `401`.
:::

## Testing your Elasticsearch connection

Before (or after) wiring it into your app, confirm the cluster and credentials
work end-to-end.

**1. Ping the cluster** — is it reachable and are the credentials valid?

```bash
curl -u elastic:$ELASTICSEARCH_PASSWORD http://localhost:9200     # Basic auth
curl -H "Authorization: ApiKey $ES_API_KEY" http://localhost:9200 # or an API key
```

A JSON body with `version.number` means you're in. A `401 security_exception`
means the credentials are wrong.

**2. Smoke-test the driver** — index a throwaway document, search it, verify
tenant isolation, then clean up. Save as `smoke.mjs` and run
`node --env-file=.env smoke.mjs`:

```ts
import { ElasticsearchDriver } from '@basaltkit/search-elasticsearch'

const driver = new ElasticsearchDriver({
  node: process.env.ELASTICSEARCH_URL,
  username: process.env.ELASTICSEARCH_USERNAME, // or apiKey: process.env.ES_API_KEY
  password: process.env.ELASTICSEARCH_PASSWORD,
  refresh: 'wait_for', // make writes visible immediately (tests only)
})

const INDEX = 'basalt_smoke_test'
await driver.register({ name: INDEX, fields: ['title'], filterable: [] })
await driver.index(INDEX, { id: '1', tenantId: 'demo', title: 'Hello Basalt' })

const found = await driver.search(INDEX, { tenantId: 'demo', q: 'hello' })
console.log('found:', found.total, found.hits[0]?.document.title) // → 1 'Hello Basalt'

const other = await driver.search(INDEX, { tenantId: 'other', q: 'hello' })
console.log('other tenant sees:', other.total) // → 0  (isolation holds)

await driver.clear(INDEX) // leave no trace
```

Seeing `found: 1 'Hello Basalt'` and `other tenant sees: 0` confirms indexing,
relevance, and tenant isolation all work against your cluster.

**3. In the app** — `searchPlugin` calls `register` for every index at boot, so a
bad connection or bad credentials **fail fast at startup**. If the app boots, the
connection is good; then hit your search route.

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
