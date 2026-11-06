---
"@basaltkit/auth": minor
---

Custom access-token claims and tenant-bound tokens (BK-017). `tokenClaims(user, { reason, amr?, request? })` adds claims to every access token `Auth` signs — login, MFA completion, social / SSO login and every refresh (re-derived, so a rotated token keeps them); reserved names (`sub`, `tv`, `amr`, `iat`, `exp`, `nbf`, `iss`, `aud`, `jti`) fail with `AUTH_TOKEN_CLAIM_RESERVED`. `authPlugin({ verifyClaims })` checks a bearer token's claims before the user lookup; `false` answers `401 AUTH_TOKEN_CLAIMS_REJECTED`. `tenantBoundTokens()` returns both for schema-per-tenant apps: tokens carry `tid` (the `ctx().tenant` id, `null` on the central plane) and are refused on any other plane, even when the same user id exists there. Opt-in: without these options tokens and verification are unchanged.
