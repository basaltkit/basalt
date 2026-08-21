# @basaltkit/auth-saml

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
