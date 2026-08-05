---
"@machize/fastify": minor
"@machize/env": minor
"@machize/auth": minor
---

Production hardening (M1 — secure by default):

- `@machize/fastify`: new `securityPlugin` (rate limiting with a pluggable store, CORS with allow-listing + preflight, and secure response headers — HSTS, nosniff, frame-deny, referrer-policy, COOP), and `healthPlugin` with distinct `/livez` (liveness) and `/readyz` (readiness, runs dependency checks → 503 when any fails).
- `@machize/env`: new `secret()` schema — fail-closed in production (required, rejects placeholder-looking values, enforces a minimum length) while keeping a `devDefault` for local runs.
- `@machize/auth`: brute-force lockout on `login()` via `LoginThrottle` (enabled by default, per-email rolling window, cleared on success; `loginThrottle: false` to disable).
