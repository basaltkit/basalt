# @machize/auth

## 0.8.0

### Patch Changes

- @machize/core@0.8.0
- @machize/fastify@0.8.0

## 0.7.0

### Patch Changes

- @machize/core@0.7.0
- @machize/fastify@0.7.0

## 0.6.0

### Patch Changes

- @machize/core@0.6.0
- @machize/fastify@0.6.0

## 0.5.1

### Patch Changes

- @machize/fastify@0.5.1
- @machize/core@0.5.1

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

- @machize/core@0.5.0
- @machize/fastify@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ed43e86]
- Updated dependencies [3e26f2a]
  - @machize/fastify@0.4.0
  - @machize/core@0.4.0

## 0.3.0

### Minor Changes

- 94a01eb: Production hardening (M1 — secure by default):

  - `@machize/fastify`: new `securityPlugin` (rate limiting with a pluggable store, CORS with allow-listing + preflight, and secure response headers — HSTS, nosniff, frame-deny, referrer-policy, COOP), and `healthPlugin` with distinct `/livez` (liveness) and `/readyz` (readiness, runs dependency checks → 503 when any fails).
  - `@machize/env`: new `secret()` schema — fail-closed in production (required, rejects placeholder-looking values, enforces a minimum length) while keeping a `devDefault` for local runs.
  - `@machize/auth`: brute-force lockout on `login()` via `LoginThrottle` (enabled by default, per-email rolling window, cleared on success; `loginThrottle: false` to disable).

### Patch Changes

- Updated dependencies [4846bc1]
- Updated dependencies [8a0ccbc]
- Updated dependencies [b405334]
- Updated dependencies [7b92e25]
- Updated dependencies [94a01eb]
  - @machize/fastify@0.3.0
  - @machize/core@0.3.0

## 0.1.0

### Minor Changes

- Initial public release of the Machize ecosystem — a batteries-included,
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
    travel), create-machize, sdk (typed client from Zod endpoints),
    generator (mach make).
  - **Admin/product**: admin and dashboard (headless engines), admin-react
    (React binding).

  This is an early, pre-1.0 release: APIs may change before 1.0, and several
  stores ship in-memory (see KNOWN_LIMITATIONS.md).

### Patch Changes

- Updated dependencies
  - @machize/core@0.1.0
  - @machize/fastify@0.1.0
