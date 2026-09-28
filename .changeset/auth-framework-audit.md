---
'@basaltkit/auth': major
---

Security fixes from the framework audit (FA-012, FA-013, FA-014, FA-042).

- **An unset `NODE_ENV` is production (FA-013).** `Auth` used to apply its production defaults only on `NODE_ENV === 'production'`, while `@basaltkit/env` (and the docs) treat an unset `NODE_ENV` as production — so a deploy that forgot `NODE_ENV` booted with a short signing secret and minted session cookies without `Secure`. The 32-character secret floor (`AUTH_WEAK_SECRET`), the session cookie's `Secure` default and the OAuth binding cookie's `Secure`/`__Host-` default now use `isProductionEnvironment()` from `@basaltkit/core`: anything but an explicit `NODE_ENV=development` or `test` is production.
- **An unreadable session cookie is anonymous, not a 500 (FA-012).** `sessionIdFromCookie()` threw a `URIError` on a malformed percent-encoding (`basalt_session=%E0%A4%A`); the enricher runs on every route, so any request carrying such a cookie — e.g. one tossed by a sibling subdomain — got `500` on public routes too. It now returns `null`.
- **Throttle eviction no longer unlocks a locked account (FA-014).** When the in-memory `MemoryThrottleStore` is full it evicts the oldest *unlocked* entries; a locked identifier is only evicted when every tracked entry is locked (the memory bound stays absolute). `ThrottleStore.hit()` gains an optional third parameter, `limit` (the caller's budget), which `LoginThrottle` now passes; existing custom stores that ignore it keep working.
- **JWT strings are no longer malleable (FA-042).** `verifyJwt()` rejects segments with characters outside the base64url alphabet and non-canonical signature encodings — `token + '!!!'` or a tweaked final character used to verify, defeating denylists or idempotency keyed on the exact token string.

**Why major:** an app that runs without `NODE_ENV` (or with `staging`, etc.) and a secret shorter than 32 characters now fails to boot with `AUTH_WEAK_SECRET`, and its session / OAuth binding cookies now carry `Secure` (they are not sent over plain HTTP). Set `NODE_ENV=development` locally, use a secret of at least 32 characters (`secret({ minLength: 32 })` from `@basaltkit/env`), or pass `sessionCookie: { secure: false }` / `bindingCookie: { secure: false }` explicitly. Vitest sets `NODE_ENV=test`, so test suites are unaffected.
