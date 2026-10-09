---
'@basaltkit/core': minor
'@basaltkit/auth': patch
'@basaltkit/drives': patch
---

BK-027: one AEAD for secrets at rest. `@basaltkit/core/secret-box` (a new subpath, not re-exported from the main entry) exports `createSecretBox({ keys, info, version, aadFields })` — AES-256-GCM with HKDF-SHA256 keys from a key ring, AAD binding to ordered context fields, no plaintext path — and `SecretBoxError`.

`@basaltkit/auth`'s `SecretBox` (`bka2`) and `@basaltkit/drives`' `DriveSecretBox` (`bkd1`) are now thin wrappers over it. Their public APIs, error classes and codes are unchanged, and existing ciphertexts stay byte-compatible (pinned by golden vectors sealed with the previous implementations). One hardening in drives: `DriveSecretBox.reseal` now authenticates an envelope already on the active key before returning `null`, as auth's box always did, so a tampered current blob is reported instead of vouched for.
