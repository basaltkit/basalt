---
"@basaltkit/prisma": major
---

The optional `@basaltkit/http` peer range moves from 2.x to `^3`; no API change. The major is forced by the peer leaving its 2.x range: the request lease reads `ctx().onDispose` from the app's http pipeline, so the plugin must sit next to the same `@basaltkit/http` the adapter runs. Upgrade it together with `@basaltkit/http` 3 and a 3.x adapter.
