---
'@basaltkit/auth': major
'@basaltkit/auth-prisma': minor
'@basaltkit/auth-sqlite': minor
---

Security hardening (secure-by-default changes):

- **API keys are bound to their tenant.** A key issued inside a tenant is refused (`403 AUTH_APIKEY_TENANT_MISMATCH`) on any request that resolves a different tenant, or none. Keys issued without a tenant are refused on tenant-scoped requests unless `apiKeysPlugin({ allowTenantlessKeys: true })`.
- **API-key scopes are an upper bound.** A key without `*` can no longer act as its owner on `meta.auth`/`can`/`teamRole`/`audience` routes that declare no `meta.scopes` (opt-out: `allowNarrowKeysOnUnscopedRoutes: true`). New `meta.apiKey: false` makes a route session-only; `apiKeyRoutes()` and `mfaRoutes()` declare it, so a key can no longer mint, list or revoke keys, or change MFA.
- **Social/SSO login** links to an existing account only when the provider verified the email (`SocialLinkRefusedError`). It honours the account's MFA (`MfaRequiredError`; explicit `mfa: 'skip'` opt-out on `socialLogin` / `oauthPlugin`). When it adopts an account whose email was never verified, it revokes that account's password, sessions, refresh tokens and MFA (`auth:social_account_adopted`).
- **OAuth flows are browser-bound and single-use.** `oauthRoutes` sets an HttpOnly binding cookie, the signed `state` carries its hash, and the code exchange uses PKCE (S256) plus an OIDC nonce. `OAuth.authorizeUrl` now takes a `binding` (use the new `OAuth.authorize()`), and `OAuth.callback` requires it.
- **Cookie-session CSRF check** in `authPlugin`: a cross-site/same-site, cookie-only, state-changing request is not authenticated (`403 AUTH_CSRF_REJECTED`). Configure it with `csrf: { trustedOrigins }`, or turn it off with `csrf: false`.
- `enrollMfa` refuses an account whose MFA is already on (`MfaAlreadyEnabledError`), so re-enrolling can no longer switch MFA off without a code.
- TOTP anti-replay and recovery-code consumption are atomic. `MfaStore` gains optional `consumeTotpStep` / `consumeRecoveryCode`, which the memory, SQLite and Prisma stores implement.
- Login throttling reserves the attempt before verifying it, so parallel bursts cannot exceed the budget. `LoginThrottle` stores hashed keys and is bounded (`maxEntries`).
- Auth route inputs are size-capped (email 254, password 1024, tokens 512). The public auth routes declare a default `meta.rateLimit` (`authRoutes({ rateLimit })` to tune or turn off). Reset and verification emails are throttled per account (`emailRequestThrottle`).
- Emails are case-insensitive identities: `Auth` canonicalises them, and the memory, SQLite (NOCASE lookup and unique index) and Prisma (canonical storage and case-insensitive fallback lookup) stores match them case-insensitively.
- `revokeAllTokens` also revokes refresh tokens and sessions. `refresh()` refuses tokens of deleted users, and a rotated token can no longer outlive a concurrent family revocation.
- New security events: `auth:mfa_failed`, `auth:locked_out`, `auth:refresh_reused` and `auth:apikey_rejected`.
