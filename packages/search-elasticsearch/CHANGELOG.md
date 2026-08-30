# @basaltkit/search-elasticsearch

## 1.2.0

### Minor Changes

- 104cfb3: `index()` and `bulk()` now write the same `_id` for the same document.
  
  The driver had **two** id builders: `bulk()` used the raw `${tenantId}:${id}` while `index()` and `remove()` used a per-segment percent-encoded form. For any id carrying a URL-special character (a space, `/`, `#`, `%`), the same document indexed singly and in bulk landed under two different `_id`s — silent duplicates — and `remove()` could not delete a bulk-indexed one. There is now one definition, the encoded form, used everywhere.
  
  Encoding the segments also closes the `:` ambiguity the review flagged: tenant `a:b` + id `c` no longer collides with tenant `a` + id `b:c`, which previously overwrote one tenant's document with another's (a write-side data loss; reads were never leaked, the stored `tenantId` still gates search). This matches how the Meilisearch driver already encodes its primary key.
  
  **Upgrade note.** Plain UUID/slug ids are unaffected — `encodeURIComponent` leaves them untouched, so nothing re-indexes. Only documents whose tenant id or document id contains a special character change address; re-index them if you have any.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
  - @basaltkit/search@1.3.2

## 1.1.1

### Patch Changes

- Validate index names / prefix at the driver boundary so a crafted name can not break out of the REST URL path.

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
