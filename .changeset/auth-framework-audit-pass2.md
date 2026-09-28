---
'@basaltkit/auth': major
---

Security fixes from the framework audit, pass 2 (FA-051, FA-056, FA-058, FA-059, FA-H22, scrypt cost ceiling).

- **`WebAuthnService.remove()` checks the owner (FA-051).** `remove(credentialId)` deleted any user's passkey by id. It is now `remove(userId, credentialId)` and throws `PASSKEY_NOT_FOUND` for an unknown id or one `userId` does not own (the same error for both).
- **OIDC providers can be restricted to their email domains (FA-056).** A customer's IdP could assert `victim@other.com` with `email_verified` and log into that account. `oidcProvider` / `discoverOidcProvider` (and any `OAuthProvider`) accept `allowedEmailDomains` (and `allowAnyEmailDomain: true`); a login for another domain fails with `AUTH_OAUTH_EXCHANGE_FAILED` before an account is looked up. With more than one provider configured, every enterprise (OIDC) provider must declare one or the other — `OAuth` otherwise refuses to start with the new `OAuthProviderConfigError` (`AUTH_OAUTH_PROVIDER_CONFIG`), which also rejects duplicate provider names and malformed domains.
- **Provider replies are validated (FA-058).** A profile without a string `sub`/`email` no longer logs into an account literally named `"undefined"`; the email must be a single-`@` address. An `openid` flow must return an `id_token`, whose `aud` (client id), `exp` and — when the provider declares an `issuer` — `iss` are now checked alongside the nonce (`googleProvider` declares Google's issuer; `discoverOidcProvider` uses the discovered one). Discovery refuses a document for another issuer or with non-`https:` endpoints (plain `http:` only to loopback). A non-JSON token-endpoint reply is `AUTH_OAUTH_EXCHANGE_FAILED` instead of a 500 `SyntaxError`, and every provider call has a deadline (`oauthPlugin({ timeoutMs })`, default 10 s). `oauthRoutes` carry `meta.rateLimit` (10/min per ip and route by default; `rateLimit: false` removes it).
- **WebAuthn authentication hardening (FA-059).** `startAuthentication(sessionKey, userId)` now binds the challenge to `userId`: another user's passkey throws `WEBAUTHN_SUBJECT_MISMATCH` (step-up could be satisfied by any account). A non-integer `newCounter` from the verifier is refused instead of disabling clone detection for good. `MemoryWebAuthnChallengeStore.save()` purges expired entries in amortized O(1) instead of scanning the whole store.
- **Two different API keys on one request are ambiguous (FA-H22).** A forged `Authorization: Bearer mk_…` used to shadow a valid `x-api-key` (→ 403). When both carriers are present and differ, `apiKeysPlugin` now answers `400 AUTH_APIKEY_AMBIGUOUS` (new `ApiKeyAmbiguousError`); the same key in both is accepted.
- **The scrypt cost read from a stored hash is capped.** `ScryptPasswordHasher.verify()` returns `false` for a hash declaring more than N=2^20, r=32, p=16 or 512 MiB, or malformed parameters (it used to run — or throw — at whatever cost the row declared). The constructor refuses such parameters.

**Why major, and how to migrate:**
- `passkeys.remove(id)` → `passkeys.remove(userId, id)`, with `userId` from the authenticated session.
- An `OAuth` setup with **several providers** that includes an `oidcProvider` / `discoverOidcProvider` without `allowedEmailDomains` now fails at startup: add `allowedEmailDomains: ['customer.com']` per IdP, or `allowAnyEmailDomain: true` for an IdP you fully control.
- `discoverOidcProvider` now requires the discovery document's `issuer` to equal the configured one and `https:` endpoints; an `openid`-scoped provider must return an `id_token` with a matching `aud` and a future `exp`.
- A step-up `startAuthentication(sessionKey, userId)` answered with another user's passkey now throws instead of returning that user.
- Clients sending two different API keys get 400; send exactly one.
- A `ScryptPasswordHasher` configured beyond the ceilings throws at construction.
