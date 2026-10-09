---
"@basaltkit/comments": minor
---

BK-078: `commentRoutes({ meta })` merges extra route metadata into every route
(a guard such as `{ can: 'comments:write' }`, a rate limit, OpenAPI tags).
`auth: true` is always applied on top and cannot be switched off.
