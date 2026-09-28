---
'@basaltkit/search-elasticsearch': major
---

`index()`, `bulk()` and `remove()` address the same `_id` again for ids with URL-special characters (framework audit, FA-061).

The document id is `<encodeURIComponent(tenantId)>:<encodeURIComponent(id)>`. The `_bulk` body carried it verbatim, but the `/_doc/<id>` path put it in raw, and Elasticsearch percent-decodes path segments: `acme:a%20b` in the path became the `_id` `acme:a b`. So `remove()` of a bulk-indexed document whose id held a space, `/`, `%`, `?`, `#`, `+`, a non-ASCII letter, … deleted nothing (404, swallowed) and it stayed searchable; `index()` plus `bulk()` of one document stored two; and on the single-document path tenant `a:b` + id `c` still collided with tenant `a` + id `b:c`. The path now encodes the id once more (`:` kept literal), so ES decodes it to exactly the bulk `_id`. The package's own test compared the two after decoding both, which is the step ES skips for the bulk body — it now models ES.

**Why major — migration:** documents written by `index()` (single, not bulk) whose tenant or id contained such a character were stored under the decoded `_id`; they are now unreachable by `remove()`/`index()` and would be duplicated. Plain UUID/slug/numeric ids are byte-for-byte unchanged. If any of your ids can contain those characters, rebuild the index once — `search.reindex(name)` (it clears first) or clear and re-run your indexing.
