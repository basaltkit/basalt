---
"@basaltkit/permissions": major
---

Requires `@basaltkit/http` 3; no API change. The plugin shares the app's `@basaltkit/http`: it augments its `RouteMeta` with `meta.can` (types that would land on a private copy and leave the app's routes untyped), and the `meta.can` resource loader throws `RequestValidationError`, which the adapter maps to `400` with an `instanceof` check — from a second copy of `@basaltkit/http` that would be a `500`. Upgrade it together with `@basaltkit/http` 3 and a 3.x adapter.
