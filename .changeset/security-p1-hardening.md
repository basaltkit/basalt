---
"@basaltkit/auth": minor
"@basaltkit/logger": minor
"@basaltkit/hono": minor
"create-basalt": patch
---

Security P1 — secure-by-default hardening:

- **auth:** the `Auth` constructor now fails closed on a weak JWT signing secret — an empty secret is always rejected, and in production a secret shorter than 32 chars throws `WeakJwtSecretError` (a short HS256 key is offline-forgeable). (H-1)
- **logger:** default log redaction is broader and deeper. It previously matched only the exact key `token`, so `accessToken`/`refreshToken`/`cookie` logged in clear; it now redacts the token/secret/credential/cookie names this framework actually mints, at the top level and one level of nesting. (PII F1)
- **hono:** the adapter enforces a request body-size limit (default 1 MiB, `honoPlugin({ bodyLimit })`) — a request whose `Content-Length` exceeds it gets 413 before the body is read. Hono/edge has no default cap. (HTTP HIGH-2)
- **create-basalt:** generated apps now include `securityPlugin()` by default, so secure response headers are set from the first deploy. (HTTP HIGH-1)
