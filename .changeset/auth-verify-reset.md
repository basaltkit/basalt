---
'@machize/auth': minor
---

Add email verification and password reset flows.

- New `Auth` methods: `requestEmailVerification`, `verifyEmail`, `requestPasswordReset`, `resetPassword`, backed by a single-use `AuthTokenStore` (in-memory by default, pluggable).
- New routes in `authRoutes()`: `POST /auth/verify/request`, `POST /auth/verify`, `POST /auth/password/forgot`, `POST /auth/password/reset`. The request/forgot routes always return `200` to prevent account enumeration.
- Tokens are delivered out-of-band: `auth:verify_requested` and `auth:password_reset_requested` hooks carry the token so the app emails the link; it is never returned over HTTP.
- A successful password reset revokes every refresh token for the user (logs all sessions out).
- `PublicUser` now carries `emailVerified`. `UserSource` gains an optional `update()` and `RefreshTokenStore` an optional `revokeAllForUser()`; `MemoryUserSource`/`MemoryRefreshTokenStore` implement both.
