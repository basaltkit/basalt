---
"@machize/subscriptions": minor
---

Resolve the metered-consumption race (KNOWN_LIMITATIONS #2). The `UsageStore`
contract gains an atomic `consume(billableId, feature, periodKey, amount, limit)`
returning `{ applied, used }`. `RedisUsageStore` implements it with a Lua script
run via `EVAL` (atomic on the server, so concurrent callers never overshoot a
quota); `MemoryUsageStore` implements it race-free in the event loop.
`Subscriptions.features().consume` now routes limited features through the
atomic path (unlimited features are just tracked).
