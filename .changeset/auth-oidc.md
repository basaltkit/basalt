---
"@basaltkit/auth": minor
---

Add generic **OIDC** SSO on top of the OAuth flow: `oidcProvider({ authorizeUrl, tokenUrl, userInfoUrl, clientId, clientSecret })` for any OpenID Connect IdP (Okta, Azure AD / Entra ID, Auth0, Google Workspace, Keycloak), and `discoverOidcProvider({ issuer, clientId, clientSecret })` which resolves the endpoints from the IdP's `.well-known/openid-configuration`. Maps the standard `sub`/`email`/`email_verified`/`name` claims. (SAML 2.0 remains a separate, future integration.)
