# @basaltkit/auth

## 1.3.1

### Patch Changes

- MFA recovery codes now carry 80 bits of entropy (was 40) — a leaked recovery-code hash is no longer brute-forceable offline.

## 1.3.0

### Minor Changes

- TOTP anti-replay + per-IP login throttle, weak JWT-secret guard, opt-in access-token revocation (TokenVersionStore) and TOTP secret encryption at rest, and enumeration-safe registration.

## 1.2.0

### Minor Changes

- Security: **refresh tokens and session ids are now hashed at rest.** Both were persisted in plaintext, so a read of the refresh-token or session table could be replayed to hijack a live session. Only `sha256(value)` is now stored and looked up — the raw value exists solely in the client's cookie/token. Refresh tokens are hashed in the core (stores need no change); session stores hash the id they mint (see `@basaltkit/auth-sqlite` / `-prisma` 1.2.0), returning the raw id to the caller and echoing it back from `find`.

  **Upgrade note:** tokens and sessions issued before upgrading stop validating — every user is logged out once and must re-authenticate. No schema change (the same `token`/`id` columns now hold a 64-char hex hash).

## 1.1.0

### Minor Changes

- Security hardening (password reset, one-time tokens, login, hashing):
  - **A password reset now invalidates active server-side sessions**, not just refresh tokens. Previously a reset revoked refresh-token clients but left cookie/session logins alive, so a stolen session survived the reset. `SessionStore` gains an optional `deleteAllForUser(userId)` (implemented by the in-memory, sqlite and prisma stores) and `resetPassword` calls it. Custom stores should implement it to close the gap.
  - **One-time tokens (email verification, password reset) are stored hashed.** The token was persisted in plaintext, so a read of the token table let an attacker reset or verify any account with a live token. Only `sha256(token)` is now stored and looked up; the raw token exists solely in the user's emailed link. Any tokens issued before upgrading stop validating (they're short-lived — re-request).
  - **Login no longer leaks account existence via timing.** `attempt()` returned immediately for an unknown email while a real one paid the full hash cost — a timing oracle for enumeration. A miss now runs a dummy verify so both paths cost the same.
  - **Default scrypt cost raised** from N=2^14 to N=2^16 (r=8, p=1, ~64 MiB/hash), with `maxmem` set so higher-cost hashes derive and verify without hitting Node's default memory ceiling. Cost parameters are embedded per hash, so existing hashes keep verifying at their stored cost.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0
- @basaltkit/fastify@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0
- @basaltkit/fastify@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0
- @basaltkit/fastify@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0
- @basaltkit/fastify@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0
- @basaltkit/fastify@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0
- @basaltkit/fastify@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0
- @basaltkit/fastify@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0
- @basaltkit/fastify@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0
- @basaltkit/fastify@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0
- @basaltkit/fastify@0.15.0

## 0.14.0

### Patch Changes

- @basaltkit/core@0.14.0
- @basaltkit/fastify@0.14.0

## 0.13.0

### Patch Changes

- @basaltkit/core@0.13.0
- @basaltkit/fastify@0.13.0

## 0.12.0

### Patch Changes

- @basaltkit/core@0.12.0
- @basaltkit/fastify@0.12.0

## 0.11.0

### Patch Changes

- @basaltkit/core@0.11.0
- @basaltkit/fastify@0.11.0

## 0.10.0

### Patch Changes

- @basaltkit/core@0.10.0
- @basaltkit/fastify@0.10.0

## 0.9.0

### Patch Changes

- @basaltkit/core@0.9.0
- @basaltkit/fastify@0.9.0

## 0.8.1

### Patch Changes

- @basaltkit/core@0.8.1
- @basaltkit/fastify@0.8.1

## 0.8.0

### Patch Changes

- @basaltkit/core@0.8.0
- @basaltkit/fastify@0.8.0

## 0.7.0

### Patch Changes

- @basaltkit/core@0.7.0
- @basaltkit/fastify@0.7.0

## 0.6.0

### Patch Changes

- @basaltkit/core@0.6.0
- @basaltkit/fastify@0.6.0

## 0.5.1

### Patch Changes

- @basaltkit/fastify@0.5.1
- @basaltkit/core@0.5.1

## 0.5.0

### Minor Changes

- f86b32d: Add API keys for programmatic, tenant-scoped access.

  - New `ApiKeys` service: `issue`, `verify`, `list`, `revoke`, `get`. The plaintext key (`mk_live_…`) is returned exactly once; only its SHA-256 hash and a short display prefix are stored.
  - New `apiKeysPlugin({ store?, header?, users? })`: an enricher that authenticates `Authorization: Bearer mk_…` (or the `x-api-key` header) onto `ctx().apiKey`, and a guard enforcing `meta.scopes` on routes (`*` grants all). Emits `auth:apikey_issued` / `auth:apikey_revoked` for audit.
  - New `apiKeyRoutes()`: `POST /apikeys`, `GET /apikeys`, `DELETE /apikeys/:id`, all requiring a logged-in user and scoped to the caller's tenant + user.
  - New store contract `ApiKeyStore` with `MemoryApiKeyStore`; `scopesSatisfy()` helper and `ScopeRequiredError` (403).
  - The existing JWT enricher now ignores `mk_`-prefixed bearers so keys and JWTs coexist on the same header.

- 43d3d4b: Add multi-factor authentication (TOTP) with recovery codes.

  - Self-contained RFC 6238 TOTP implementation (no dependencies): `generateTotpSecret`, `totp`, `verifyTotp` (constant-time, drift window), `otpauthUri` for QR codes, plus `base32Encode`/`base32Decode`. Verified against the RFC test vectors.
  - `Auth` methods: `enrollMfa` (returns secret + `otpauth://` URI), `activateMfa` (verifies a code, enables MFA, returns 10 single-use recovery codes shown once), `disableMfa`, `verifyMfaCode`, `isMfaEnabled`, `mfaStatus`.
  - Login integration is backward compatible: `login(email, password, mfaCode?)` gains an optional third argument. A correct password on an MFA account with no code throws `MfaRequiredError` (401 `AUTH_MFA_REQUIRED`) without counting as a failed attempt; a wrong code throws `MfaInvalidCodeError`. Recovery codes are single-use and stored only as SHA-256 hashes.
  - `mfaRoutes()`: `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`, `GET /auth/mfa/status`, `POST /auth/mfa/disable` (all require a logged-in user). `POST /auth/login` accepts an optional `mfaCode`.
  - New `MfaStore` contract with `MemoryMfaStore`; emits `auth:mfa_enabled` / `auth:mfa_disabled`.

- 6c85cc8: Add email verification and password reset flows.

  - New `Auth` methods: `requestEmailVerification`, `verifyEmail`, `requestPasswordReset`, `resetPassword`, backed by a single-use `AuthTokenStore` (in-memory by default, pluggable).
  - New routes in `authRoutes()`: `POST /auth/verify/request`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`. The request/forgot routes always return `200` to prevent account enumeration.
  - Tokens are delivered out-of-band: `auth:verify_requested` and `auth:password_reset_requested` hooks carry the token so the app emails the link; it is never returned over HTTP.
  - A successful password reset revokes every refresh token for the user (logs all sessions out).
  - `PublicUser` now carries `emailVerified`. `UserSource` gains an optional `update()` and `RefreshTokenStore` an optional `revokeAllForUser()`; `MemoryUserSource`/`MemoryRefreshTokenStore` implement both.

### Patch Changes

- @basaltkit/core@0.5.0
- @basaltkit/fastify@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @basaltkit/fastify@0.4.0
  - @basaltkit/core@0.4.0

## 0.3.0

### Minor Changes

- 94a01eb: Production hardening (M1 — secure by default):

  - `@basaltkit/fastify`: new `securityPlugin` (rate limiting with a pluggable store, CORS with allow-listing + preflight, and secure response headers — HSTS, nosniff, frame-deny, referrer-policy, COOP), and `healthPlugin` with distinct `/livez` (liveness) and `/readyz` (readiness, runs dependency checks → 503 when any fails).
  - `@basaltkit/env`: new `secret()` schema — fail-closed in production (required, rejects placeholder-looking values, enforces a minimum length) while keeping a `devDefault` for local runs.
  - `@basaltkit/auth`: brute-force lockout on `login()` via `LoginThrottle` (enabled by default, per-email rolling window, cleared on success; `loginThrottle: false` to disable).

### Patch Changes

- Updated dependencies [4846bc1]
- Updated dependencies [8a0ccbc]
- Updated dependencies [b405334]
- Updated dependencies [7b92e25]
- Updated dependencies [94a01eb]
  - @basaltkit/fastify@0.3.0
  - @basaltkit/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Basalt ecosystem — a batteries-included,
  self-hosted toolkit for building SaaS applications on Node.js with Fastify,
  Prisma, Zod and TypeScript.

  Included in 0.1.0:

  - **Foundation**: core (DI container, plugin lifecycle, AsyncLocalStorage
    context, hooks), config, env, events, logger.
  - **Infrastructure**: fastify adapter (typed routes, enrichers, guards),
    prisma (tenant-scoping extension, per-tenant client pool), cache, queue,
    scheduler, storage, mailer, cli.
  - **SaaS domain**: tenancy (resolvers, per-request context, hooks), auth
    (password hashing, JWT with refresh rotation + reuse detection, sessions),
    permissions (roles, wildcards, policies, tenant scoping), subscriptions
    (plans, trials, feature limits, gateway drivers, idempotent webhooks),
    audit, activity, notifications.
  - **Developer experience**: testing (createTestApp, mail/queue fakes, time
    travel), create-basalt, sdk (typed client from Zod endpoints),
    generator (basalt make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @basaltkit/core@0.1.0
  - @basaltkit/fastify@0.1.0
