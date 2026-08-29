---
'@basaltkit/http': minor
---

`GUARDED_META_KEYS` gains `scopes`, `subscribed` and `feature`, closing an unguarded-route hole.

**Advisory — this tightens boot behavior.** The guarded-meta boot check exists so that a route *declaring* protection can never serve without a guard *enforcing* it. Three keys in that exact class were missing from the set: `meta.scopes` (enforced by `@basaltkit/auth`'s `apiKeysPlugin`) and `meta.subscribed` / `meta.feature` (enforced by `@basaltkit/subscriptions`' `subscriptionsPlugin`). A route declaring any of them with its enforcing plugin absent booted happily and served the scope-gated or paid endpoint to everyone — the failure mode the check was built to prevent.

Those keys are now guarded, and both plugins claim them. An app that declares one of them without registering the enforcing plugin will now **fail at boot** with `UnguardedRouteMetaError` instead of serving unprotected. That is the intended fail-closed outcome, but it can surface as a new boot failure on upgrade. Two remedies, in order of preference: register the enforcing plugin (`apiKeysPlugin`, `subscriptionsPlugin`), or — only when protection genuinely happens at an outer edge — waive it deliberately with the adapter option `allowUnguardedMeta: ['scopes']` (or `['subscribed', 'feature']`).

The boot error now also names the plugin that enforces each offending key, so the fix is in the message.

Keys that *relax* a check rather than request one stay deliberately unguarded: `central` (a `tenantMembershipPlugin` bypass — a missing plugin removes the bypass, never a check), `mcp` (an exposure opt-in) and `rateLimit` (abuse throttling, not an authorization boundary, and legal to declare while `securityPlugin`'s optional rate limiter is off).
