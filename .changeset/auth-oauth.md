---
"@basaltkit/auth": minor
---

Add **OAuth / social login** (Google, GitHub) — OAuth 2.0 authorization-code flow, no SDK, cookieless.

- `oauthPlugin({ secret, providers })` + `oauthRoutes({ callbackBaseUrl, successRedirect? })` register `GET /auth/oauth/:provider` (→ authorize redirect) and `GET /auth/oauth/:provider/callback` (verify state → exchange code → log in).
- `googleProvider(...)` and `githubProvider(...)` prebuilt (GitHub reads the primary *verified* email); bring your own via the `OAuthProvider` contract.
- The CSRF `state` is HMAC-signed and stateless (no server storage). New accounts are created passwordless and matched by email; a verified email flips `emailVerified`.
- New `Auth.socialLogin(email, { emailVerified })` primitive (find-or-create + issue tokens). Injectable `fetch`/clock for testing.
