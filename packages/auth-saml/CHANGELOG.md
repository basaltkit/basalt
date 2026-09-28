# @basaltkit/auth-saml

## 3.0.0

### Major Changes

- e53db52: Security fixes from the framework audit, pass 2 (FA-057, FA-060).
  
  - **SAML logins are bound to the browser that started them (FA-057, login CSRF).** The ACS consumed any valid `SAMLResponse`, so an attacker could start a login in their own browser and auto-POST the resulting response from a victim's browser, logging the victim into the attacker's account. New `Saml.authorize(name)` returns `{ url, binding }` and sends `samlRelayStateFor(binding)` (its SHA-256) as the `RelayState`; `Saml.consume(name, body, { binding })` refuses a response whose `RelayState` does not match. `samlRoutes` keep the binding in an HttpOnly `__Host-basalt_saml` cookie (`SameSite=None; Secure`, as the IdP returns with a cross-site POST; `bindingCookie: { secure?, maxAgeSeconds? }`). Enforced with `validateInResponseTo: 'always'` (the default); `bindToBrowser: false` opts out.
  - **node-saml errors are a 400 (FA-057).** Every error `validatePostResponseAsync` throws (malformed XML, bad signature, unknown `InResponseTo`, encrypted assertion…) is now `AUTH_SAML_RESPONSE_INVALID` instead of a 500.
  - **Hardening (FA-060).** A configured `emailAttribute` is now the only email source (no silent fallback to other claims or the NameID). New per-provider `wantAuthnResponseSigned` (default `true`; `false` for IdPs that sign only the assertion) and `acceptedClockSkewMs` (at most 5 min). `RelayState` is capped at 1024 characters, and the login and ACS routes carry `meta.rateLimit` (10/min per ip and route by default; `samlRoutes({ rateLimit: false })` removes it).
  
  **Why major, and how to migrate:** with the default options, `Saml.consume()` now requires the browser binding. `samlRoutes()` handle it for you. Custom routes must start the login with `saml.authorize(name)`, keep `binding` where only that browser can present it (an HttpOnly cookie that survives a cross-site POST), and pass it to `saml.consume(name, body, { binding })` — or set `bindToBrowser: false` to keep the old behaviour. The login route no longer forwards a caller-supplied `RelayState` while binding is on (the slot carries the binding). A provider with `emailAttribute` whose assertions lack that attribute (and used to fall back to `email`/NameID) is now refused — fix the attribute name.
- b69ea05: SAML responses signed with SHA-1 are refused by default (framework audit FA-060).
  
  node-saml 5 verifies XML-DSig with any algorithm xml-crypto supports, SHA-1 included, and has no verification-side option to restrict it. `Saml.consume()` now parses the `SAMLResponse` (with the same `@xmldom/xmldom` parser node-saml uses) before handing it to node-saml and requires every `SignatureMethod` and `DigestMethod` — the envelope signature and the nested assertion signature, in any namespace prefix — to use an allowlisted algorithm. Default: RSA-SHA256/384/512 and ECDSA-SHA256/384/512 signatures over SHA-256/384/512 digests (exported as `DEFAULT_SAML_SIGNATURE_ALGORITHMS` / `DEFAULT_SAML_DIGEST_ALGORITHMS`). Anything else, a `SignatureMethod`/`DigestMethod` without an `Algorithm`, or a response carrying a DOCTYPE / entity declarations is a `400 AUTH_SAML_RESPONSE_INVALID`.
  
  New per-provider options: `allowSha1: true` (legacy opt-in, adds `rsa-sha1` / `ecdsa-sha1` and the `sha1` digest), `signatureAlgorithms` and `digestAlgorithms` (algorithm URI lists replacing the defaults; an empty or invalid list fails at boot with `AUTH_SAML_PROVIDER_CONFIG`). New exports `samlAlgorithmPolicy(provider)` and `assertSamlResponseAlgorithms(samlResponse, policy)` (for a custom `createClient`). The node-saml client is now configured with `signatureAlgorithm: 'sha256'` and `digestAlgorithm: 'sha256'` for what this SP signs (node-saml's default is SHA-1).
  
  **Why major, and how to migrate:** an IdP that still signs with SHA-1 (older AD FS / Shibboleth configurations) now fails every login with `AUTH_SAML_RESPONSE_INVALID`. Switch the IdP to SHA-256 (recommended), or set `allowSha1: true` on that provider until it can. The check also runs in front of an injected `createClient`, so test stubs must post a well-formed (base64) XML `SAMLResponse`.

### Patch Changes

- Updated dependencies [e54b7b1]
- Updated dependencies [b69ea05]
- Updated dependencies [e53db52]
- Updated dependencies [e54b7b1]
- Updated dependencies [e54b7b1]
- Updated dependencies [e54b7b1]
- Updated dependencies [b69ea05]
- Updated dependencies [e53db52]
  - @basaltkit/auth@4.0.0
  - @basaltkit/core@1.5.0
  - @basaltkit/http@2.6.0

## 2.0.0

### Major Changes

- fb85c40: Security hardening (secure-by-default changes):
  
  - Each SAML provider can be restricted to the email domains it may assert (`allowedEmailDomains`); with more than one provider the list is required at boot (explicit opt-out: `allowAnyEmailDomain: true`), so one customer's IdP can no longer log in as another customer's users.
  - `validateInResponseTo` now defaults to `'always'` (unsolicited / IdP-initiated responses are refused unless you opt in with `'ifPresent'`), and consumed assertion ids are kept in a single-use `assertionReplayCache` so a captured response cannot be re-posted.
  - The `@node-saml/node-saml` peer range is raised to `^5.1.0`, and the plugin refuses to boot on older releases with known signature-bypass vulnerabilities.

### Patch Changes

- Updated dependencies [fb85c40]
- Updated dependencies [fb85c40]
  - @basaltkit/auth@3.0.0
  - @basaltkit/http@2.1.0

## 1.2.1

### Patch Changes

- Updated dependencies [36ab1a1]
- Updated dependencies [36ab1a1]
- Updated dependencies [d5ca076]
  - @basaltkit/auth@2.0.0
  - @basaltkit/http@2.0.0

## 1.2.0

### Minor Changes

- 104cfb3: SAML responses are now bound to an AuthnRequest this SP issued — assertion replay is rejected by default.
  
  **Advisory — this tightens a default.** `defaultCreateClient` set `wantAssertionsSigned: true` but left node-saml's `validateInResponseTo` at its library default of `never`. With no request-id cache, a captured `SAMLResponse` can be replayed for as long as its `NotOnOrAfter` window lasts, and nothing binds the response to the login the user actually started. The default is now `'ifPresent'`: a response carrying an `InResponseTo` must match an outstanding, not-yet-consumed AuthnRequest.
  
  The request ids live in `cacheProvider` — node-saml's **in-process** cache unless you supply one. On a multi-replica deployment without sticky sessions, a login started on one replica and returning to another will now fail with `AUTH_SAML_RESPONSE_INVALID`. Two remedies: pass a shared `cacheProvider` (Redis, your database — the `SamlCacheProvider` interface is exported), or opt out explicitly with `validateInResponseTo: 'never'` and accept the replay window.
  
  `samlClientConfig(provider, options)` is exported so the security-relevant defaults can be asserted without constructing a real client.

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/auth@1.8.0
  - @basaltkit/http@1.14.0
  - @basaltkit/core@1.3.1

## 1.1.0

### Minor Changes

- 2fb6c59: **SAML 2.0 SSO** + cross-adapter form-body support.

  - New **`@basaltkit/auth-saml`** package: SP-initiated SAML 2.0 login built on the vetted `@node-saml/node-saml` XML-DSig library (no hand-rolled crypto), plugging validated assertions into `Auth.socialLogin`. `samlPlugin({ providers })` + `samlRoutes()` add `/auth/saml/:provider/login`, `…/acs` and `…/metadata`. Adapter-agnostic.
  - **Fastify and Express adapters now parse `application/x-www-form-urlencoded`** into the request body (Hono already did), so the SAML ACS POST — and HTML form submissions in general — work on any adapter.

### Patch Changes

- Updated dependencies [6354c41]
- Updated dependencies [edbf998]
- Updated dependencies [90e48fe]
  - @basaltkit/auth@1.4.0
  - @basaltkit/http@1.5.0
