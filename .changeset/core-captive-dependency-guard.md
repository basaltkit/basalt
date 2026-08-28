---
"@basaltkit/core": minor
---

Fail-loud captive-dependency guard in the Container.

A `singleton` factory that resolved a `scoped` token used to capture it silently: the singleton is memoized on its owning container and outlives every scope, so ONE request's scoped instance became part of an app-wide service and was served to every later request. The container now throws the new `CaptiveDependencyError` (`code: 'DI_CAPTIVE_DEPENDENCY'`, exported from the barrel) the moment a scoped token is resolved while a singleton build is in flight — naming both tokens and pointing at the fix (resolve the scoped service at use time, e.g. from `ctx().container`, not at construction).

The check is O(1) and allocation-free on the hot path (an integer counter incremented per singleton build plus one compare per scoped resolution; micro-benched at no measurable cost). Legitimate graphs are untouched — singleton→singleton/transient, scoped→singleton, and a singleton deliberately managing its own `createScope()` all behave exactly as before.
