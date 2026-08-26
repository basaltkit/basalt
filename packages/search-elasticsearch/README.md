<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/search-elasticsearch

[Elasticsearch](https://www.elastic.co/elasticsearch) / [OpenSearch](https://opensearch.org) driver for [`@basaltkit/search`](https://github.com/basaltkit/basalt/tree/main/packages/search).

Targets the REST API directly — **no SDK**, an injectable `fetch`, so the
requests are unit-tested without a cluster. Works against Elasticsearch 8.x and
OpenSearch 2.x, which share this query surface.

**Tenant isolation is enforced on every operation**: documents are stored under
a compound id (`<tenantId>:<id>`) so ids never collide across tenants, and every
search is constrained with a `tenantId` term filter — results never leak between
tenants.

## Installation

```bash
pnpm add @basaltkit/search @basaltkit/search-elasticsearch
```

## Usage

```ts
import { searchPlugin } from '@basaltkit/search'
import { ElasticsearchDriver } from '@basaltkit/search-elasticsearch'

const driver = new ElasticsearchDriver({
  node: process.env.ES_NODE!,          // e.g. http://localhost:9200
  apiKey: process.env.ES_API_KEY,      // or username + password (Basic auth)
  indexPrefix: process.env.NODE_ENV === 'production' ? '' : 'dev_',
})

createApp({ plugins: [searchPlugin({ driver, indexes: [/* defineIndex(...) */] })] })
```

Or use it directly:

```ts
await driver.register({ name: 'posts', fields: ['title', 'body'], filterable: ['status'] })
await driver.index('posts', { id: 'p1', tenantId: 'acme', title: 'Hello', body: '…', status: 'published' })

const { hits, total } = await driver.search('posts', {
  tenantId: 'acme',
  q: 'hello',
  filters: { status: 'published' },
  limit: 20,
})
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `node` | — | Cluster base URL (required) |
| `apiKey` | — | `Authorization: ApiKey <key>` |
| `username` / `password` | — | Basic auth (alternative to `apiKey`) |
| `indexPrefix` | `''` | Prepended to every index name |
| `refresh` | `false` | `true` / `'wait_for'` makes writes immediately visible (dev/tests) |
| `fetch` | global `fetch` | Injectable HTTP client |

## Mapping

`register()` maps searchable `fields` as `text` with a `.keyword` sub-field (so
they're also filterable/sortable), filterable-only fields as `keyword`, and
`id` / `tenantId` as `keyword`. Searches use `multi_match` (`best_fields`) over
the searchable fields with `track_total_hits` for an exact total; filters become
`term` / `terms` clauses under the tenant scope.

## Notes

- The **fetch client is injectable** (`options.fetch`) — the global `fetch` is
  used by default. No hard HTTP dependency.
- Leave `refresh: false` in production and let the cluster's refresh interval
  handle visibility; use `'wait_for'` only in tests/dev.
- **Validated end-to-end against a live Elasticsearch 8.x cluster** — index,
  search, `term`/`terms` filters, paging with an exact `total`, `bulk`, `remove`,
  and tenant isolation — in addition to the unit tests. Still worth a smoke test
  against your exact version (especially OpenSearch).
