---
'@basaltkit/tenancy': patch
'@basaltkit/ai': minor
---

Security P2 — institutionalize:

- **`@basaltkit/tenancy` (fix):** `normalizeDomain` now strips *all* trailing dots,
  not just one — `example.com..` normalized to `example.com.` (non-idempotent),
  which could sidestep the custom-domain dedup/lookup. Found by a new property/fuzz
  test. Now idempotent and canonical for every input.
- **`@basaltkit/ai`:** new `ai:doctor` security rule **`in-memory-security-store`** —
  warns when WebAuthn passkeys/challenges, roles & permissions, or verified custom
  domains are kept in an in-memory store (lost on restart, not shared across
  instances → lockouts or authorization drift in production).

Also adds parser property/fuzz tests (SSE encoder injection-resistance, domain
normalization totality/idempotence, TOTP roundtrip) that run in CI on every change.
