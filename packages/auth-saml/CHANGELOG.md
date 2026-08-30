# @basaltkit/auth-saml

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
