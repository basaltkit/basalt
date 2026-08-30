---
'@basaltkit/auth-saml': minor
---

SAML responses are now bound to an AuthnRequest this SP issued — assertion replay is rejected by default.

**Advisory — this tightens a default.** `defaultCreateClient` set `wantAssertionsSigned: true` but left node-saml's `validateInResponseTo` at its library default of `never`. With no request-id cache, a captured `SAMLResponse` can be replayed for as long as its `NotOnOrAfter` window lasts, and nothing binds the response to the login the user actually started. The default is now `'ifPresent'`: a response carrying an `InResponseTo` must match an outstanding, not-yet-consumed AuthnRequest.

The request ids live in `cacheProvider` — node-saml's **in-process** cache unless you supply one. On a multi-replica deployment without sticky sessions, a login started on one replica and returning to another will now fail with `AUTH_SAML_RESPONSE_INVALID`. Two remedies: pass a shared `cacheProvider` (Redis, your database — the `SamlCacheProvider` interface is exported), or opt out explicitly with `validateInResponseTo: 'never'` and accept the replay window.

`samlClientConfig(provider, options)` is exported so the security-relevant defaults can be asserted without constructing a real client.
