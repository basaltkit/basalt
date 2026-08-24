---
'@basaltkit/auth': patch
---

Document social login (OAuth/OIDC) in the package README: `oauthPlugin`,
`oauthRoutes`, `googleProvider`/`githubProvider`/`oidcProvider`, the two routes
per provider, the `OAUTH` token, `Auth.socialLogin`, the OAuth error codes, and a
FAQ entry for the "redirect_uri is not associated" mismatch (callbackBaseUrl must
be the app's base URL, not the full callback path).
