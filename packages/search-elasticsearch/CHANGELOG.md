# @basaltkit/search-elasticsearch

## 1.0.1

### Patch Changes

- Validated end-to-end against a live Elasticsearch 8.x cluster (index, search,
  `term`/`terms` filters, paging with an exact total, `bulk`, `remove`, and
  tenant isolation). No code changes — docs only.

## 1.0.0

### Initial release

- Elasticsearch / OpenSearch driver for the `@basaltkit/search` `SearchDriver`
  contract, talking to the REST API directly (no SDK) with an injectable
  `fetch`. `register` maps text (`.keyword` sub-field) + keyword fields; `search`
  uses `multi_match` with `track_total_hits` and `term`/`terms` filters.
  Tenant-scoped throughout: compound `<tenantId>:<id>` document ids and a
  mandatory `tenantId` filter on every search. Idempotent `register`, 404-safe
  `remove`, NDJSON `bulk`.
