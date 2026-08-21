---
"@basaltkit/cache": minor
---

Add stale-while-revalidate to `remember`.

`cache.remember(key, { ttl, staleFor }, factory)` serves a value fresh for `ttl`, then serves it **stale immediately** for a further `staleFor` window while a single background revalidation refreshes it; only after `ttl + staleFor` does a read block on the factory again. Concurrent stale reads dedupe into one background refresh (same stampede protection as `remember`), and a throwing refresh keeps serving stale until hard expiry instead of surfacing an error.

- Freshness windows are gated in the Cache layer via an injectable `now` clock (`CacheOptions.now`), independent of driver eviction.
- Works through `tags(...).remember(...)`; plain `get()` transparently unwraps SWR entries.
- The plain `remember(key, ttl, factory)` signature is unchanged. New `SwrOptions` type exported.
