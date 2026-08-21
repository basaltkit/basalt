---
"@basaltkit/http": minor
"@basaltkit/storage": minor
"@basaltkit/search": minor
"@basaltkit/auth": patch
"@basaltkit/search-postgres": patch
"@basaltkit/search-elasticsearch": patch
---

Security polish — the remaining low/medium audit items:

- **http:** `securityPlugin` now emits a restrictive default `Content-Security-Policy` (`default-src 'none'; frame-ancestors 'none'`) when secure headers are enabled — overridable via `contentSecurityPolicy`, or `false` to omit. Adds per-route rate limits via `route.meta.rateLimit` ({ limit, windowMs }) so sensitive endpoints (login, reset) can be stricter than the global bucket.
- **storage:** facade-level key validation across every driver (rejects leading-slash, `..` segments and control chars — `STORAGE_INVALID_KEY`), plus opt-in `maxBytes` / `allowedContentTypes` upload limits on `put()`. Note: facade key rejection now throws `STORAGE_INVALID_KEY` (was `STORAGE_INVALID_PATH`; the local driver's internal root-boundary guard still uses the latter).
- **search / search-postgres / search-elasticsearch:** validate table and index identifiers at the driver boundary (config-time), so a table/index name wired from an external value can't inject into DDL or REST URL paths. Request input was already parameterized.
- **auth:** MFA recovery codes now carry 80 bits of entropy (was 40), so a leaked recovery-code hash can't be brute-forced offline.
