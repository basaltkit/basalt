---
'@basaltkit/realtime': minor
---

Bridge rules can omit `tenant`. The push then goes to the tenant in the active context at emit time (`ctx().tenant.id`, set by `@basaltkit/tenancy`), so schema- and database-per-tenant apps whose payloads carry no `tenantId` can use the bridge. If the rule has no `tenant` and the context has no tenant either, the event is skipped and reported through the new `onBridgeSkipped({ hook, channel, event, reason: 'no-tenant' })` option. By default that option calls `console.warn` once per rule. A `tenant` resolver that returns `undefined` still skips silently.
