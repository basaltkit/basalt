---
'@basaltkit/auth-saml': major
---

SAML responses signed with SHA-1 are refused by default (framework audit FA-060).

node-saml 5 verifies XML-DSig with any algorithm xml-crypto supports, SHA-1 included, and has no verification-side option to restrict it. `Saml.consume()` now parses the `SAMLResponse` (with the same `@xmldom/xmldom` parser node-saml uses) before handing it to node-saml and requires every `SignatureMethod` and `DigestMethod` — the envelope signature and the nested assertion signature, in any namespace prefix — to use an allowlisted algorithm. Default: RSA-SHA256/384/512 and ECDSA-SHA256/384/512 signatures over SHA-256/384/512 digests (exported as `DEFAULT_SAML_SIGNATURE_ALGORITHMS` / `DEFAULT_SAML_DIGEST_ALGORITHMS`). Anything else, a `SignatureMethod`/`DigestMethod` without an `Algorithm`, or a response carrying a DOCTYPE / entity declarations is a `400 AUTH_SAML_RESPONSE_INVALID`.

New per-provider options: `allowSha1: true` (legacy opt-in, adds `rsa-sha1` / `ecdsa-sha1` and the `sha1` digest), `signatureAlgorithms` and `digestAlgorithms` (algorithm URI lists replacing the defaults; an empty or invalid list fails at boot with `AUTH_SAML_PROVIDER_CONFIG`). New exports `samlAlgorithmPolicy(provider)` and `assertSamlResponseAlgorithms(samlResponse, policy)` (for a custom `createClient`). The node-saml client is now configured with `signatureAlgorithm: 'sha256'` and `digestAlgorithm: 'sha256'` for what this SP signs (node-saml's default is SHA-1).

**Why major, and how to migrate:** an IdP that still signs with SHA-1 (older AD FS / Shibboleth configurations) now fails every login with `AUTH_SAML_RESPONSE_INVALID`. Switch the IdP to SHA-256 (recommended), or set `allowSha1: true` on that provider until it can. The check also runs in front of an injected `createClient`, so test stubs must post a well-formed (base64) XML `SAMLResponse`.
