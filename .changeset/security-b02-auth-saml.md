---
'@basaltkit/auth-saml': major
---

Security hardening (secure-by-default changes):

- Each SAML provider can be restricted to the email domains it may assert (`allowedEmailDomains`); with more than one provider the list is required at boot (explicit opt-out: `allowAnyEmailDomain: true`), so one customer's IdP can no longer log in as another customer's users.
- `validateInResponseTo` now defaults to `'always'` (unsolicited / IdP-initiated responses are refused unless you opt in with `'ifPresent'`), and consumed assertion ids are kept in a single-use `assertionReplayCache` so a captured response cannot be re-posted.
- The `@node-saml/node-saml` peer range is raised to `^5.1.0`, and the plugin refuses to boot on older releases with known signature-bypass vulnerabilities.
