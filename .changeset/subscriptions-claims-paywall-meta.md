---
'@basaltkit/subscriptions': minor
---

`subscriptionsPlugin` claims `meta.subscribed` and `meta.feature` in the adapters' guarded-meta boot check.

The plugin registered a guard for both keys but never claimed them, so — together with their absence from `@basaltkit/http`'s `GUARDED_META_KEYS` — a paywalled route in an app that forgot `subscriptionsPlugin` booted and served the paid feature to everyone. Registering the plugin now makes those routes boot; omitting it fails loud instead of failing open. Requires `@basaltkit/http` with the extended key set.
