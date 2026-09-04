# @basaltkit/auth

## 2.0.0

### Major Changes

- d5ca076: **Zod 3 is no longer supported.** These packages now require zod 4.
  
  The peer range was `^3.24.0 || ^4.0.0`. It is now `^4.0.0`, which is a breaking
  change for any application still on zod 3: the install will refuse the peer
  rather than fail somewhere subtle at runtime, which is the point of declaring it.
  
  The move itself was overdue — the repository has been testing against zod 4 only
  for some time, through a workspace override, so the second half of that range was
  a claim nobody was checking. Supporting a major version you never run is worse
  than not supporting it: it holds back the API surface (a schema written against
  zod 4's `z.iso.datetime()` cannot be expressed in 3) while promising a
  compatibility that would break on first contact.
  
  **Upgrading.** Most applications need only `pnpm add zod@^4`. Zod's own 3-to-4
  migration guide covers the API changes; the ones that touch Basalt users most are
  `z.string().datetime()` becoming `z.iso.datetime()`, and error customisation
  moving from `message`/`invalid_type_error` to a single `error` parameter.
  
  The peer asks for `^4.0.0` and not the version this repo happens to test —
  requiring the newest 4.x would force every consumer to move in step with us for
  no reason. `@basaltkit/ai` takes zod as a direct dependency rather than a peer,
  so its range narrowing is not breaking for anyone.
  
  **The zod 3 code goes with it.** `@basaltkit/http` carried a hand-rolled
  `switch` over `_def.typeName` — 75 lines reimplementing what zod 4's
  `z.toJSONSchema` does natively — reachable only when the native converter was
  absent, which now never happens. `@basaltkit/mcp` normalised two shapes of
  `_def` for every introspection. Both are gone, along with the coverage test
  that existed solely to drive the dead path by mocking zod's converter away.
  
  `create-app` also scaffolded UI applications pinned to `zod@^3.24.0`. A project
  generated after this change would have failed its own install against the new
  peer; it now scaffolds `^4.0.0`.

### Patch Changes

- 36ab1a1: `authRoutes()` accepts a password policy.
  
  The rule was `min(8)`, fixed, with no way to change it. Eight characters is the
  2012 minimum, and an application holding case files or medical records has every
  reason to ask for more — but the only way was to stop using these routes.
  
  One application instead reached into the route's Zod object and swapped the
  `password` field while preserving the rest. That works, and depends on the
  internal shape of a body it does not own: any change here breaks it silently,
  with no compile error.
  
  ```ts
  authRoutes({ password: { minLength: 12 } })
  
  // or the schema itself, for rules a length cannot express
  authRoutes({
    password: z.string().min(10).refine((p) => /[^a-zA-Z0-9]/.test(p), 'needs a symbol'),
  })
  ```
  
  It applies to `/auth/password/reset` as well as `/auth/register`. Covering
  register and leaving reset behind would let anyone walk a strong password back
  down to eight characters through "forgot password" — a loophole worse than
  having no option at all.
  
  The default stays `min(8)`: raising it would start rejecting passwords that
  already work.
- 36ab1a1: Give route `meta` a shape, and refuse to boot on a plan that is not in the
  catalogue.
  
  **`meta.subscribed` is now checked at boot.** The toolkit already refused to
  boot a route declaring `meta.subscribed` without `subscriptionsPlugin` — it
  checked the *plugin* existed, never that the *value* meant anything.
  `Subscriptions.subscribed()` compares strings and returns false when they do not
  match, and the guard turns that into a 402. So a route gated on a plan absent
  from the catalogue was indistinguishable from one nobody subscribed to: it
  answered 402 to every paying customer, forever, with nothing in the logs.
  
  `subscriptionsPlugin` now validates every `meta.subscribed` against the plans it
  was given and throws `UnknownPlanMetaError`, naming all offending routes at once
  and listing what the catalogue does have. The check runs on `app:booted`, not in
  the plugin's own boot: adapters publish `http:routes` during *their* boot phase,
  so reading the list earlier would depend on plugin order and silently pass.
  
  **`meta` is typed.** It was `Record<string, unknown>`, so `can: 123` compiled.
  `RouteMeta` is exported from `@basaltkit/http` and augmented by each guard
  plugin — `can` by permissions, `subscribed`/`feature` by subscriptions, `auth`
  by auth — the same pattern `BasaltHooks` uses.
  
  It stays open. The index signature keeps every existing route compiling and lets
  applications add their own keys, which means a **misspelt** key still compiles:
  `subcribed: 'pro'` is not a type error. That gap is closed at boot instead, by
  the two checks above. The typing catches wrong value types and lets an editor
  complete the names.
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/http@2.0.0

## 1.8.0

### Minor Changes

- 104cfb3: Refresh-token reuse detection is now atomic — a compare-and-swap, not a read-then-write.
  
  **Advisory — this changes a store contract.** `Auth.refresh()` reads the record, checks `usedAt`, then calls `markUsed()`. The database stores implemented `markUsed` as an unconditional `UPDATE … WHERE token = ?`, so the check and the write were not one operation: two concurrent refreshes of the same token — the legitimate client and a thief racing it — could both read `usedAt = null` and both succeed. Rotation-reuse detection, the whole point of the family, never fired. Verified live: `Promise.allSettled([auth.refresh(t), auth.refresh(t)])` returned **two** valid token pairs.
  
  `AuthTokenStore.markUsed` and `RefreshTokenStore.markUsed` now return `Promise<boolean | void>`: `true` when *this* call consumed the token, `false` when someone else already had. The shipped stores do a conditional update (`WHERE token = ? AND used_at IS NULL`, `where: { token, usedAt: null }`) and report the row count. `Auth.refresh()` treats `false` as reuse — it revokes the family and throws `AUTH_REFRESH_REUSED`; `consumeToken()` (email verification, password reset) treats it as a spent token and throws `AUTH_TOKEN_INVALID`. The same race now resolves to exactly one winner and one `RefreshReusedError`.
  
  Returning `void` keeps the pre-CAS behaviour, so a **third-party store written against the old contract keeps compiling and working** — without the race protection. If you maintain one, make `markUsed` conditional and return whether it consumed the token.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.7.0

### Minor Changes

- 59cf29c: `apiKeysPlugin` claims `meta.scopes` in the adapters' guarded-meta boot check.
  
  The plugin registered a guard enforcing `meta.scopes` but never claimed the key, so a scope-gated route in an app without `apiKeysPlugin` served with no scope check at all. It now claims it: the same route fails loud at boot when the plugin is missing. Requires `@basaltkit/http` with the extended key set.

### Patch Changes

- Updated dependencies [59cf29c]
  - @basaltkit/http@1.13.0

## 1.6.4

### Patch Changes

- a76d591: `authPlugin` claims `'auth'` in the `http:guarded-meta` bucket so the adapters' new boot check knows `meta.auth` is enforced. No API or behavior change in this package itself; apps that mount `meta.auth` routes *without* `authPlugin` now fail loud at boot (see the adapter releases).
- Updated dependencies [a76d591]
  - @basaltkit/http@1.12.0

## 1.6.3

### Patch Changes

- 3d09275: Depend on the neutral HTTP contract, not the Fastify adapter.
  
  The package imported `route`/`BasaltRoute`/`RouteGuard`/`RequestEnricher` through `@basaltkit/fastify`, which merely re-exports them from `@basaltkit/http` — but carries a hard `fastify` dependency. Imports now come straight from `@basaltkit/http`, and the runtime dependency swaps `@basaltkit/fastify` → `@basaltkit/http` (`@basaltkit/fastify` stays as a devDependency for the test suite). Express and Hono apps no longer install Fastify transitively through this package. No public API change — the symbols are byte-identical re-exports.

## 1.6.0

### Minor Changes

- c305a67: Security hardening from a deep adversarial audit of this release's new components.

  - **dashboard (CRITICAL):** `brandingStyleSheet`/`brandingCssVars` now strictly validate custom-property names and values and drop anything that could break out of the `<style>` element — closes a tenant-controlled stored-XSS/CSS-injection vector in the white-label shell. Analytics `subscriptionMrr` uses `Number.isFinite` so `NaN`/`Infinity` prices can't poison MRR.
  - **auth:** the WebAuthn registration challenge is now bound to its subject — `finishRegistration` throws `WEBAUTHN_SUBJECT_MISMATCH` unless the `userId` matches the one `startRegistration` was called with (prevents binding a passkey to another account), rejects a duplicate credential id (`PASSKEY_EXISTS`) instead of overwriting, namespaces registration vs authentication challenges, validates the credential id type, and the in-memory challenge store now purges expired entries + caps size. **`WebAuthnChallengeStore` now stores/returns `StoredChallenge` objects** (was a bare string).
  - **tenancy:** custom-domain `verify`/`instructions`/`remove` are now tenant-scoped (`DomainForbiddenError`); a shared `normalizeDomain` (lowercase/port/trailing-dot/IDNA) is used by registration, lookup AND the Host resolver; `MemoryDomainStore.add` rejects duplicates atomically; `verify(tenantId, domain, { force })` re-checks DNS and **revokes** on failure (dangling-domain defence); new `findByVerifiedDomain` helper wires only verified domains into `TenantSource.findByDomain`.
  - **prisma:** `readReplica` gains `extend` (apply the same extension to primary AND every replica — prevents an un-scoped replica leaking all tenants) and routes `$queryRaw`/`$queryRawUnsafe` to the **primary by default** (opt back in with `rawReadsOnReplica`). `ShardRouter` defensively copies its shards.
  - **http:** SSE `encodeSseEvent` strips CR/LF/NUL from `id`/`event` (event-stream injection) and splits `data` on all line terminators; `send()` now returns a boolean backpressure signal.
  - **core:** `renderDependencyGraph` escapes token descriptions so a label can't break out of / inject HTML into the Mermaid node.

### Patch Changes

- Updated dependencies [c305a67]
  - @basaltkit/core@1.1.1

## 1.5.0

### Minor Changes

- bad5a6a: WebAuthn / passkeys. `WebAuthnService` drives the full registration and
  authentication ceremonies — issuing challenges, assembling the browser options,
  storing credentials, single-use challenges and the signature-counter clone
  check — while delegating the actual cryptographic verification to a pluggable
  `WebAuthnVerifier` (implement it over `@simplewebauthn/server`, so the framework
  stays crypto-dependency-free). Ships `PasskeyStore` + `WebAuthnChallengeStore`
  (in-memory defaults), discoverable (usernameless) login, and `webauthnPlugin`
  binding the service under the `WEBAUTHN` token.

## 1.4.1

### Patch Changes

- 0dd7584: Document social login (OAuth/OIDC) in the package README: `oauthPlugin`,
  `oauthRoutes`, `googleProvider`/`githubProvider`/`oidcProvider`, the two routes
  per provider, the `OAUTH` token, `Auth.socialLogin`, the OAuth error codes, and a
  FAQ entry for the "redirect_uri is not associated" mismatch (callbackBaseUrl must
  be the app's base URL, not the full callback path).

## 1.4.0

### Minor Changes

- 6354c41: Add **OAuth / social login** (Google, GitHub) — OAuth 2.0 authorization-code flow, no SDK, cookieless.

  - `oauthPlugin({ secret, providers })` + `oauthRoutes({ callbackBaseUrl, successRedirect? })` register `GET /auth/oauth/:provider` (→ authorize redirect) and `GET /auth/oauth/:provider/callback` (verify state → exchange code → log in).
  - `googleProvider(...)` and `githubProvider(...)` prebuilt (GitHub reads the primary _verified_ email); bring your own via the `OAuthProvider` contract.
  - The CSRF `state` is HMAC-signed and stateless (no server storage). New accounts are created passwordless and matched by email; a verified email flips `emailVerified`.
  - New `Auth.socialLogin(email, { emailVerified })` primitive (find-or-create + issue tokens). Injectable `fetch`/clock for testing.

- edbf998: Add generic **OIDC** SSO on top of the OAuth flow: `oidcProvider({ authorizeUrl, tokenUrl, userInfoUrl, clientId, clientSecret })` for any OpenID Connect IdP (Okta, Azure AD / Entra ID, Auth0, Google Workspace, Keycloak), and `discoverOidcProvider({ issuer, clientId, clientSecret })` which resolves the endpoints from the IdP's `.well-known/openid-configuration`. Maps the standard `sub`/`email`/`email_verified`/`name` claims. (SAML 2.0 remains a separate, future integration.)

### Patch Changes

- Updated dependencies [2fb6c59]
  - @basaltkit/fastify@1.4.0

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
