---
"@basaltkit/subscriptions": major
---

Requires `@basaltkit/http` 3; no API change. The plugin augments the app's `@basaltkit/http` `RouteMeta` with `meta.subscribed` and `meta.feature`; against a private copy of http those types would not reach the app's routes. Upgrade it together with `@basaltkit/http` 3 and a 3.x adapter.
