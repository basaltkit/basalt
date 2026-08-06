---
'@machize/auth': minor
---

Add multi-factor authentication (TOTP) with recovery codes.

- Self-contained RFC 6238 TOTP implementation (no dependencies): `generateTotpSecret`, `totp`, `verifyTotp` (constant-time, drift window), `otpauthUri` for QR codes, plus `base32Encode`/`base32Decode`. Verified against the RFC test vectors.
- `Auth` methods: `enrollMfa` (returns secret + `otpauth://` URI), `activateMfa` (verifies a code, enables MFA, returns 10 single-use recovery codes shown once), `disableMfa`, `verifyMfaCode`, `isMfaEnabled`, `mfaStatus`.
- Login integration is backward compatible: `login(email, password, mfaCode?)` gains an optional third argument. A correct password on an MFA account with no code throws `MfaRequiredError` (401 `AUTH_MFA_REQUIRED`) without counting as a failed attempt; a wrong code throws `MfaInvalidCodeError`. Recovery codes are single-use and stored only as SHA-256 hashes.
- `mfaRoutes()`: `POST /auth/mfa/enroll`, `POST /auth/mfa/activate`, `GET /auth/mfa/status`, `POST /auth/mfa/disable` (all require a logged-in user). `POST /auth/login` accepts an optional `mfaCode`.
- New `MfaStore` contract with `MemoryMfaStore`; emits `auth:mfa_enabled` / `auth:mfa_disabled`.
