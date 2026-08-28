---
"@basaltkit/core": minor
---

`HookBus.emit` now isolates handlers — one failure no longer starves the rest.

Previously the first throwing handler aborted the chain: later handlers and every `onAny` observer (the audit trail, devtools) silently never ran, and the raw error propagated into the emitting domain code. `emit` now runs **every** handler and every `onAny` observer (same contract as `EventBus.emit`), then surfaces failures: a single failure rethrows the original error unchanged; several become an `AggregateError`. Nothing is swallowed — a failing hook still fails the emitter — but the audit trail can no longer have holes. Only code relying on a throwing hook *preventing subsequent handlers from running* is affected; no such usage exists in the ecosystem (verified by sweep).
