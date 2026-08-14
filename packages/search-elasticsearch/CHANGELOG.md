# @basaltkit/search-elasticsearch

## 1.1.0

### Minor Changes

- Security: **an index with no configured `fields` now searches via `simple_query_string`, not `query_string`.** The `query_string` query exposes full Lucene syntax to raw user input — field probing (`_index:*`), unbounded leading wildcards, and regex that can pin a node (DoS). `simple_query_string` never throws on malformed input and can't reach fields the user wasn't given. Indexes with declared fields (which use `multi_match`) are unaffected.

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
