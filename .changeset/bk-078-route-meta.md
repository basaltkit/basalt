---
"@basaltkit/files": minor
"@basaltkit/api-keys-ui": minor
"@basaltkit/billing-ui": minor
"@basaltkit/teams-ui": minor
---

BK-078: `fileRoutes()`, `apiKeysUiRoutes()`, `billingUiRoutes()` and
`teamsUiRoutes()` accept `meta`, merged into every route they mount — a guard
such as `{ teamRole: 'admin' }` or `{ can: 'billing:manage' }`, a rate limit,
OpenAPI tags. `auth: true` is always applied on top and cannot be switched off.
Without `meta` the routes are unchanged.
