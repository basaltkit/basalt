---
'@basaltkit/auth': minor
'@basaltkit/teams': patch
---

**auth** — MFA by policy, shared throttles, cookie-only logout, account routes.

- `authPlugin({ requireMfa: true | (user, context) => boolean | Promise<boolean> })` refuses authenticated requests whose credential was not obtained with a second factor: `403 AUTH_MFA_ENROLLMENT_REQUIRED` (`MfaEnrollmentRequiredError`) or `403 AUTH_MFA_REQUIRED` (`MfaStepUpRequiredError`). Routes declaring `meta.mfa: false` are exempt (all `authRoutes()`, MFA enroll/activate/status); `meta.mfa: true` requires MFA on a single route (step-up). Off by default.
- Access tokens carry an `amr` claim (`['pwd']`, `['pwd', 'mfa']`, `['fed', …]`), refresh rotation keeps it, cookie sessions carry it HMAC-signed in the session id (no store schema change), and the enricher exposes it as `ctx().amr`. `login()` / `socialLogin()` also return `amr`; `createSession(userId, { amr })` and `sessionAuth(id)` are new.
- `ThrottleStore` interface with `MemoryThrottleStore` (default) and `RedisThrottleStore` (any ioredis-compatible client: `eval` + `del`; atomic Lua per attempt). `authPlugin({ throttleStore })` backs the default login/MFA, per-IP and email-request throttles across replicas; `new LoginThrottle({ store, namespace })` for explicit ones. With the default store `LoginThrottle` stays synchronous.
- `POST /auth/logout` no longer requires `refreshToken`: an empty body ends the cookie (or `x-session-id`) session and expires the cookie. A cross-site cookie-only logout is refused with `403 AUTH_CSRF_REJECTED` (previously a cross-site request with a refresh token could also end the cookie session).
- `authRoutes()`, `mfaRoutes()` and `oauthRoutes()` declare `meta.account: true` (+ `mfa: false`, except MFA disable); `ACCOUNT_META` is exported.

**teams** — fix: `tenantMembershipPlugin` blocked invite acceptance and sign-in. It now skips routes declaring `meta.account: true` (the neutral account-route key): the auth account routes and `POST /team/invites/accept`, which now declares it. A non-member can sign in and accept an invitation on the company's tenant; tenant data routes stay members-only.
