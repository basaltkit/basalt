---
'@basaltkit/cache': patch
---

`flush()` no longer fails closed in apps without tenancy.

`cachePlugin` correctly gates its `onMissingScope: 'error'` default on tenancy's `tenancy:active` marker, but `flush()` bypassed that and checked the resolved scope directly — so in an app with **no** `tenancyPlugin`, `cache.get()`/`put()` worked while `cache.flush()` always threw `MissingCacheScopeError`. The stated rationale ("would delete EVERY tenant's cache") does not hold when there are no tenants: the prefix is that app's own cache, and clearing it is what `flush()` means.

`flush()` now fails closed when tenancy is active **or** `onMissingScope: 'error'` was set explicitly, so every deliberate fail-closed configuration is preserved and multi-tenant apps are unchanged. `scope: null` (a deliberate global cache) may still always flush. `new Cache(driver, options, tenancyActive?)` takes an optional third argument.
