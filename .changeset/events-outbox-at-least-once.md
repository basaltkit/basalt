---
"@basaltkit/events": minor
---

**Outbox: the at-least-once contract is now real (Q-5).**

**What was broken.** Automatic capture was fire-and-forget (`void enqueue(...)`) — a transient store-write failure dropped the event silently while the module promises "nothing is lost". The interval flush had no overlap guard, so a slow dispatch let the next tick re-select the same batch: double delivery. `markFailed` scheduled no backoff (failed entries were hammered every tick), an entry exhausting `maxAttempts` vanished from flushes with no signal, and a store fault inside the timer was an unhandled rejection.

**What changed.** Capture is awaited — a failed outbox write now fails the `emit()` (the EventBus aggregates listener errors), which is the transactional-outbox contract. Concurrent `flush()` calls coalesce onto the in-flight flush. Failed entries retry with exponential backoff (new `backoff` option, default 1 s doubling capped at 60 s; tracked per relay process — no store/schema change, a restart merely allows one immediate retry). Entries that exhaust `maxAttempts` are reported once through the new `onDead` callback (default `console.error`) and stay in the store with their `lastError`. Timer/shutdown flush faults route to the new `onFlushError` plugin option instead of crashing.
