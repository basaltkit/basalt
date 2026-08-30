---
'@basaltkit/search-elasticsearch': minor
---

`index()` and `bulk()` now write the same `_id` for the same document.

The driver had **two** id builders: `bulk()` used the raw `${tenantId}:${id}` while `index()` and `remove()` used a per-segment percent-encoded form. For any id carrying a URL-special character (a space, `/`, `#`, `%`), the same document indexed singly and in bulk landed under two different `_id`s — silent duplicates — and `remove()` could not delete a bulk-indexed one. There is now one definition, the encoded form, used everywhere.

Encoding the segments also closes the `:` ambiguity the review flagged: tenant `a:b` + id `c` no longer collides with tenant `a` + id `b:c`, which previously overwrote one tenant's document with another's (a write-side data loss; reads were never leaked, the stored `tenantId` still gates search). This matches how the Meilisearch driver already encodes its primary key.

**Upgrade note.** Plain UUID/slug ids are unaffected — `encodeURIComponent` leaves them untouched, so nothing re-indexes. Only documents whose tenant id or document id contains a special character change address; re-index them if you have any.
