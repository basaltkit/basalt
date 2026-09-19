<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/auth-saml

SAML 2.0 single sign-on for [`@basaltkit/auth`](https://www.npmjs.com/package/@basaltkit/auth). SP-initiated
login for enterprise IdPs (ADFS, Okta, OneLogin, Azure AD, Shibboleth…) that speak
SAML rather than OIDC.

Signature verification, XML canonicalization and the SAML protocol are handled by
[`@node-saml/node-saml`](https://github.com/node-saml/node-saml) — a vetted
XML-DSig implementation. This package only wires a validated assertion into
`Auth.socialLogin`, so a user proven by the IdP is logged in with the same tokens
as any other login. **This deliberately does not hand-roll SAML crypto.**

> For modern IdPs prefer OIDC — `@basaltkit/auth`'s `oidcProvider` /
> `discoverOidcProvider` cover Okta, Azure AD, Auth0, Google Workspace and
> Keycloak with no extra dependency. Reach for SAML only when the IdP requires it.

## Install

```bash
pnpm add @basaltkit/auth-saml @node-saml/node-saml   # node-saml >= 5.1.0 is a peer dependency
```

## Usage

```ts
import { authPlugin, authRoutes } from '@basaltkit/auth'
import { samlPlugin, samlRoutes } from '@basaltkit/auth-saml'

createApp({
  plugins: [
    authPlugin({ users, secret: env.APP_SECRET }),
    fastifyPlugin({ routes: [...authRoutes(), ...samlRoutes()] }),
    samlPlugin({
      providers: [
        {
          name: 'okta',
          entryPoint: 'https://acme.okta.com/app/…/sso/saml',
          idpCert: env.OKTA_IDP_CERT,          // the IdP's signing certificate (PEM)
          issuer: 'https://app.example.com/sp', // your SP entity id
          callbackUrl: 'https://app.example.com/auth/saml/okta/acs',
          allowedEmailDomains: ['acme.com'],    // this IdP may only assert @acme.com users
        },
      ],
    }),
  ],
})
```

Three routes per provider:

| Route | Purpose |
|---|---|
| `GET  /auth/saml/:provider/login` | Redirects the browser to the IdP (SP-initiated). |
| `POST /auth/saml/:provider/acs` | The IdP POSTs the signed `SAMLResponse` here; on a valid assertion the user is logged in. Responds with JSON tokens, or pass `samlRoutes({ successRedirect })` to bounce back to your SPA. |
| `GET  /auth/saml/:provider/metadata` | SP metadata XML — hand it to the IdP admin to register the app. |

The user is matched by **email** (find-or-create, passwordless); a validated
assertion is trusted, so `emailVerified` is set. Read the email from a specific
attribute with `emailAttribute` on the provider (default: `email`, common email
claims, or an email-shaped `NameID`).

`samlPlugin` is adapter-agnostic — the Fastify, Express and Hono adapters all
parse the `application/x-www-form-urlencoded` ACS POST. Register it after `authPlugin`.

## Options

| Option | Type | Default | Purpose |
|---|---|---|---|
| `providers` | `SamlProvider[]` | — (required) | IdPs: `name`, `entryPoint`, `idpCert`, `issuer`, `callbackUrl`, optional `emailAttribute`, `allowedEmailDomains` (required with several IdPs), `allowAnyEmailDomain`. |
| `validateInResponseTo` | `'never' \| 'ifPresent' \| 'always'` | `'always'` | Replay protection — bind the response to an AuthnRequest this SP issued. `'ifPresent'` opts in to IdP-initiated SSO. |
| `cacheProvider` | `SamlCacheProvider` | node-saml's in-process cache | Where outstanding AuthnRequest ids live. **Required on multi-replica deployments.** |
| `assertionReplayCache` | `SamlAssertionReplayCache` | in-process | Single-use store for consumed assertion ids (`consume(key, ttlMs) → boolean`). Share it across replicas if you opt in to IdP-initiated SSO. |
| `createClient` | `(provider) => SamlClient` | node-saml | Factory for the underlying client — injectable for tests. |
| `host` | `string` | — | Host used when building the AuthnRequest. |

`samlClientConfig(provider, options)` is exported so these defaults can be asserted without constructing a real client.

## Security notes

- **Assertions must be signed.** `wantAssertionsSigned: true` is not optional — an unsigned response is never trusted.
- **Each IdP may only assert its own email domains.** In B2B SaaS each customer's IdP admin controls what their IdP signs; without a restriction, one customer's IdP could log in as another customer's users. Set `allowedEmailDomains` on every provider (exact, case-insensitive match; list subdomains explicitly). With more than one provider it is **required** — boot fails with `AUTH_SAML_PROVIDER_CONFIG` — unless a provider explicitly sets `allowAnyEmailDomain: true` (only for an IdP you fully control).
- **Responses are bound to a request this app started.** `validateInResponseTo` defaults to `'always'` (node-saml's own default is `never`), so every response must carry an `InResponseTo` matching an outstanding, not-yet-consumed AuthnRequest; unsolicited (IdP-initiated) responses are refused. Opt in to IdP-initiated SSO with `'ifPresent'`.
- **Assertions are single-use.** Each consumed assertion id is remembered (until its `NotOnOrAfter`) in `assertionReplayCache`, so a captured `SAMLResponse` cannot be re-posted even under the IdP-initiated opt-in. When `InResponseTo` is not enforced, an assertion with no identifier, no `Conditions/@NotOnOrAfter`, or a validity longer than 24h is refused, because the replay record could expire before the assertion does.
- **Known-vulnerable node-saml is refused.** The peer range is `^5.1.0` and the plugin refuses to boot on `@node-saml/node-saml` < 5.1.0 (CVE-2025-54369 / CVE-2025-54419).
- **Multi-replica deployments need a shared `cacheProvider`.** The request ids default to an in-process cache: without sticky sessions, a login started on one replica and returning to another fails with `AUTH_SAML_RESPONSE_INVALID`. Pass a shared store (Redis, your database) implementing `SamlCacheProvider` — `saveAsync`/`getAsync`/`removeAsync`.

## Failure modes

| Error | Code | HTTP | When |
|---|---|---|---|
| `SamlProviderUnknownError` | `AUTH_SAML_UNKNOWN_PROVIDER` | 404 | `:provider` is not in the `providers` array. |
| `SamlResponseInvalidError` | `AUTH_SAML_RESPONSE_INVALID` | 400 | The assertion failed validation — bad/absent signature, expired, missing/unknown `InResponseTo`, already used, or an email outside the provider's `allowedEmailDomains`. |
| `SamlProviderConfigError` | `AUTH_SAML_PROVIDER_CONFIG` | boot | Several providers without `allowedEmailDomains`, an invalid domain entry, or `@node-saml/node-saml` < 5.1.0. |
