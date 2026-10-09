---
"@basaltkit/http": patch
---

`rawBody()` and `upload()` now mark their schemas with global `Symbol.for('basalt.http.rawBody')` / `Symbol.for('basalt.http.upload')` properties (non-enumerable, frozen) instead of module-local `WeakMap`s. A schema built by one installed copy of `@basaltkit/http` — e.g. a feature package's nested copy, as with `driveRoutes()` — is now recognised by the adapter's copy, so the route gets its raw bytes / multipart stream instead of failing closed. A cross-copy parity suite runs on Fastify, Express and Hono.
