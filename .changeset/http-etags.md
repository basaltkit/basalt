---
'@basaltkit/http': minor
---

Add conditional requests via ETags. Opt a route in with `meta: { etag: true }`:
the shared pipeline hashes the GET/HEAD response body into a strong `ETag`, and
when the client's `If-None-Match` matches it replies `304 Not Modified` with no
body — adapter-agnostic (fastify/express/hono), no handler changes. Exposes
`computeEtag` and `ifNoneMatchSatisfied`.
