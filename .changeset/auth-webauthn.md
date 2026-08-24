---
'@basaltkit/auth': minor
---

WebAuthn / passkeys. `WebAuthnService` drives the full registration and
authentication ceremonies — issuing challenges, assembling the browser options,
storing credentials, single-use challenges and the signature-counter clone
check — while delegating the actual cryptographic verification to a pluggable
`WebAuthnVerifier` (implement it over `@simplewebauthn/server`, so the framework
stays crypto-dependency-free). Ships `PasskeyStore` + `WebAuthnChallengeStore`
(in-memory defaults), discoverable (usernameless) login, and `webauthnPlugin`
binding the service under the `WEBAUTHN` token.
