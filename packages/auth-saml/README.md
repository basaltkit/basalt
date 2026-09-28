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
| `GET  /auth/saml/:provider/login` | Sets the browser-binding cookie and redirects the browser to the IdP (SP-initiated). |
| `POST /auth/saml/:provider/acs` | The IdP POSTs the signed `SAMLResponse` here; on a valid assertion **from the browser that started the login** the user is logged in. Responds with JSON tokens, or pass `samlRoutes({ successRedirect })` to bounce back to your SPA. |
| `GET  /auth/saml/:provider/metadata` | SP metadata XML — hand it to the IdP admin to register the app. |

The user is matched by **email** (find-or-create, passwordless); a validated
assertion is trusted, so `emailVerified` is set. Read the email from a specific
attribute with `emailAttribute` on the provider — then **only** that attribute is
read, with no fallback (default: `email`, common email claims, or an email-shaped
`NameID`).

`samlRoutes({ successRedirect?, bindingCookie?, rateLimit? })`: the login and ACS
routes carry `meta.rateLimit` (10 per minute per ip and route by default, enforced by
the http `securityPlugin`; `rateLimit: false` removes it). `bindingCookie` is
`{ secure?, maxAgeSeconds? }` for the binding cookie (see *Security notes*).

`samlPlugin` is adapter-agnostic — the Fastify, Express and Hono adapters all
parse the `application/x-www-form-urlencoded` ACS POST. Register it after `authPlugin`.

## Options

| Option | Type | Default | Purpose |
|---|---|---|---|
| `providers` | `SamlProvider[]` | — (required) | IdPs: `name`, `entryPoint`, `idpCert`, `issuer`, `callbackUrl`, optional `emailAttribute`, `allowedEmailDomains` (required with several IdPs), `allowAnyEmailDomain`, `wantAuthnResponseSigned` (default `true`; `false` for IdPs such as AD FS / Entra ID that sign only the assertion), `acceptedClockSkewMs` (default 0, at most 5 min). |
| `bindToBrowser` | `boolean` | `true` | Login-CSRF protection: bind each SP-initiated login to the browser that started it (see *Security notes*). |
| `validateInResponseTo` | `'never' \| 'ifPresent' \| 'always'` | `'always'` | Replay protection — bind the response to an AuthnRequest this SP issued. `'ifPresent'` opts in to IdP-initiated SSO. |
| `cacheProvider` | `SamlCacheProvider` | node-saml's in-process cache | Where outstanding AuthnRequest ids live. **Required on multi-replica deployments.** |
| `assertionReplayCache` | `SamlAssertionReplayCache` | in-process | Single-use store for consumed assertion ids (`consume(key, ttlMs) → boolean`). Share it across replicas if you opt in to IdP-initiated SSO. |
| `createClient` | `(provider) => SamlClient` | node-saml | Factory for the underlying client — injectable for tests. |
| `host` | `string` | — | Host used when building the AuthnRequest. |

`samlClientConfig(provider, options)` is exported so these defaults can be asserted without constructing a real client.

## Security notes

- **Assertions must be signed.** `wantAssertionsSigned: true` is not optional — an unsigned response is never trusted.
- **Each IdP may only assert its own email domains.** In B2B SaaS each customer's IdP admin controls what their IdP signs; without a restriction, one customer's IdP could log in as another customer's users. Set `allowedEmailDomains` on every provider (exact, case-insensitive match; list subdomains explicitly). With more than one provider it is **required** — boot fails with `AUTH_SAML_PROVIDER_CONFIG` — unless a provider explicitly sets `allowAnyEmailDomain: true` (only for an IdP you fully control). A single provider without a list may assert any email: that is only right for your own IdP.
- **Responses are bound to the browser that started the login (login CSRF).** Binding the response to an AuthnRequest is not enough: an attacker can start a login in their own browser, obtain a valid `SAMLResponse` for their own account and auto-POST it from a victim's browser, silently logging the victim into the attacker's account. `samlRoutes` therefore sets an HttpOnly binding cookie at login and sends its SHA-256 as the `RelayState`; the ACS refuses (`AUTH_SAML_RESPONSE_INVALID`) a response whose `RelayState` does not match the cookie posted with it. The IdP returns with a cross-site POST, so the cookie is `SameSite=None; Secure` and named `__Host-basalt_saml` — `bindingCookie.secure` defaults to true unless `NODE_ENV` is `development` or `test` (browsers treat `http://localhost` as secure, so `secure: true` works there too). Custom routes use `saml.authorize(name)` → `{ url, binding }` and `saml.consume(name, body, { binding })`. The binding is enforced with `validateInResponseTo: 'always'` (the default): IdP-initiated SSO has no browser to bind to and is login-CSRF-able by nature. `bindToBrowser: false` opts out.
- **Responses are bound to a request this app started.** `validateInResponseTo` defaults to `'always'` (node-saml's own default is `never`), so every response must carry an `InResponseTo` matching an outstanding, not-yet-consumed AuthnRequest; unsolicited (IdP-initiated) responses are refused. Opt in to IdP-initiated SSO with `'ifPresent'`.
- **Assertions are single-use.** Each consumed assertion id is remembered (until its `NotOnOrAfter`) in `assertionReplayCache`, so a captured `SAMLResponse` cannot be re-posted even under the IdP-initiated opt-in. When `InResponseTo` is not enforced, an assertion with no identifier, no `Conditions/@NotOnOrAfter`, or a validity longer than 24h is refused, because the replay record could expire before the assertion does.
- **Known-vulnerable node-saml is refused.** The peer range is `^5.1.0` and the plugin refuses to boot on `@node-saml/node-saml` < 5.1.0 (CVE-2025-54369 / CVE-2025-54419).
- **Multi-replica deployments need a shared `cacheProvider`.** The request ids default to an in-process cache: without sticky sessions, a login started on one replica and returning to another fails with `AUTH_SAML_RESPONSE_INVALID`. Pass a shared store (Redis, your database) implementing `SamlCacheProvider` — `saveAsync`/`getAsync`/`removeAsync`.

## Failure modes

| Error | Code | HTTP | When |
|---|---|---|---|
| `SamlProviderUnknownError` | `AUTH_SAML_UNKNOWN_PROVIDER` | 404 | `:provider` is not in the `providers` array. |
| `SamlResponseInvalidError` | `AUTH_SAML_RESPONSE_INVALID` | 400 | The response is not bound to this browser, or the assertion failed validation — malformed XML, bad/absent signature, expired, missing/unknown `InResponseTo`, already used, an encrypted assertion (not supported), or an email outside the provider's `allowedEmailDomains`. Every error node-saml throws maps here (never a 500). |
| `SamlProviderConfigError` | `AUTH_SAML_PROVIDER_CONFIG` | boot | Several providers without `allowedEmailDomains`, an invalid domain entry, an `acceptedClockSkewMs` outside 0..5 min, or `@node-saml/node-saml` < 5.1.0. |
