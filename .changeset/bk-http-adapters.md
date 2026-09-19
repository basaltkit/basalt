---
'@basaltkit/http': minor
'@basaltkit/fastify': minor
'@basaltkit/express': minor
'@basaltkit/hono': minor
---

Adapter-neutral streaming uploads and per-user/tenant rate limits.

- **`upload()` route body (BK-006).** `route({ body: upload({ maxBytes, maxFiles, maxFileBytes?, maxFields?, maxFieldBytes?, maxHeaderBytes?, allowedTypes? }) })` accepts `multipart/form-data` on Fastify, Express and Hono. The handler receives `{ files: AsyncIterable<{ field, filename, declaredType, stream }>, fields }`. `@basaltkit/http` parses the body with its own streaming RFC 7578 parser, which has no dependencies and never buffers the body. The full pipeline (pre-hooks, enrichers, guards: rate limit, tenant, auth) runs before a single body byte is read.
  - Every limit is enforced on the bytes actually received: `413 PAYLOAD_TOO_LARGE` (a larger declared `Content-Length` is refused up front), `400 TOO_MANY_FILES` / `TOO_MANY_FIELDS`, `415 UNSUPPORTED_MEDIA_TYPE`, and `400 MALFORMED_MULTIPART` for a bad or repeated boundary, a truncated body, oversized or folded part headers, or a nested multipart part.
  - Filenames are sanitised (`sanitizeFilename`): directories, drive letters, control/NUL and bidi characters are stripped.
  - An upload the handler leaves unread is drained (up to `maxBytes`) with `Connection: close`, so nothing hangs.
  - OpenAPI documents the body as `multipart/form-data`.
  - New exports: `upload`, `isUploadBody`, `uploadOptionsOf`, `sanitizeFilename`, and the types `UploadOptions`, `UploadBody`, `UploadedFile`. `HttpRequest` gains an optional `bodyStream`.
  - Per adapter:
    - Fastify registers a pass-through multipart parser, only when an upload route exists and never over one you registered yourself. Other routes still answer 415.
    - Express hands the untouched `req` stream to the parser.
    - Hono streams `c.req.raw.body`. Pre-hooks and after-hooks no longer read multipart bodies, and a non-upload route still parses them within `bodyLimit`.
- **`meta.rateLimit.key` (BK-008).** A per-route bucket can now belong to `'ip'` (default, unchanged), `'user'` (`ctx().user.id`), `'tenant'` (`ctx().tenant.id`), `'user+tenant'`, or a function of `ctx()`. The key is resolved in the route guard after enrichers ran. When there is no user or tenant it falls back to the client IP. It uses the same memory or Redis store. New type: `RateLimitKey`.
- `meta.mfa` joins the guarded route-meta keys: a route declaring `mfa: true` refuses to boot unless `authPlugin` (which now claims it) is registered.
