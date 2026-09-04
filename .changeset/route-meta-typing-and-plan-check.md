---
'@basaltkit/http': patch
'@basaltkit/subscriptions': patch
'@basaltkit/permissions': patch
'@basaltkit/auth': patch
---

Give route `meta` a shape, and refuse to boot on a plan that is not in the
catalogue.

**`meta.subscribed` is now checked at boot.** The toolkit already refused to
boot a route declaring `meta.subscribed` without `subscriptionsPlugin` — it
checked the *plugin* existed, never that the *value* meant anything.
`Subscriptions.subscribed()` compares strings and returns false when they do not
match, and the guard turns that into a 402. So a route gated on a plan absent
from the catalogue was indistinguishable from one nobody subscribed to: it
answered 402 to every paying customer, forever, with nothing in the logs.

`subscriptionsPlugin` now validates every `meta.subscribed` against the plans it
was given and throws `UnknownPlanMetaError`, naming all offending routes at once
and listing what the catalogue does have. The check runs on `app:booted`, not in
the plugin's own boot: adapters publish `http:routes` during *their* boot phase,
so reading the list earlier would depend on plugin order and silently pass.

**`meta` is typed.** It was `Record<string, unknown>`, so `can: 123` compiled.
`RouteMeta` is exported from `@basaltkit/http` and augmented by each guard
plugin — `can` by permissions, `subscribed`/`feature` by subscriptions, `auth`
by auth — the same pattern `BasaltHooks` uses.

It stays open. The index signature keeps every existing route compiling and lets
applications add their own keys, which means a **misspelt** key still compiles:
`subcribed: 'pro'` is not a type error. That gap is closed at boot instead, by
the two checks above. The typing catches wrong value types and lets an editor
complete the names.
