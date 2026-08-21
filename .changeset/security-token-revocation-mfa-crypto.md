---
"@basaltkit/auth": minor
"@basaltkit/auth-prisma": minor
"@basaltkit/auth-sqlite": minor
---

Two opt-in auth hardening features:

- **Access-token revocation (M-5):** a `TokenVersionStore` (Memory / Prisma / SQLite). When wired via `authPlugin({ tokenVersions })`, access tokens carry a version (`tv`) and `resetPassword` / the new `revokeAllTokens(userId)` bump it — invalidating every access token issued before the bump, even before its short TTL expires (real logout-everywhere for stateless JWTs). Verification moves to `verifyAccessToken()` (async); the plugin uses it automatically. Off by default (no per-request store read unless enabled).
- **TOTP secret encryption at rest (M-3):** `authPlugin({ mfaEncryptionKey })` stores TOTP secrets as AES-256-GCM `v1:` envelopes, so a database leak can't recover a live second factor. Transparent to the store adapters; legacy plaintext records still verify and are encrypted on next write. New `matchTotpStep()` already shipped; secrets decrypt only on the verify path.

Schema: `auth-prisma` adds an `AuthTokenVersion` model (run `prisma db push`); `auth-sqlite` creates `auth_token_versions` automatically. `MfaRecord` is unchanged for M-3 (ciphertext lives in the existing `secret` column).
