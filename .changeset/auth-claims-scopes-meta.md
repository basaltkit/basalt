---
'@basaltkit/auth': minor
---

`apiKeysPlugin` claims `meta.scopes` in the adapters' guarded-meta boot check.

The plugin registered a guard enforcing `meta.scopes` but never claimed the key, so a scope-gated route in an app without `apiKeysPlugin` served with no scope check at all. It now claims it: the same route fails loud at boot when the plugin is missing. Requires `@basaltkit/http` with the extended key set.
