---
'@basaltkit/cache': minor
---

Four cache fixes: glob-injected tenant ids, an unbounded default driver, leaking tag indexes, and `undefined` treated as a miss.

**Advisory — the memory driver is now bounded and the Redis tag layout changed.**

- **Cross-tenant flush via a glob in the tenant id.** `RedisCacheDriver.flushPrefix` interpolated the scope straight into `SCAN MATCH ${prefix}*`. The scope defaults to the raw tenant id, and tenant ids are often user-chosen slugs — a tenant named `a*` matched, and **deleted**, every other tenant's keys under that prefix. Glob metacharacters (`\ * ? [ ] ^`) are now escaped, so a scope is always matched literally.
- **The default driver was unbounded.** `MemoryCacheDriver` is the default and had no cap, reaping only on `get` — high key cardinality (ids, slugs, query fingerprints) grew until the process died. It is now an LRU bounded at **10 000 entries**, evicting already-expired entries first. Pass `new MemoryCacheDriver({ maxEntries })`, or `Infinity`, to change or remove the cap. Apps holding more than 10 000 live keys in process memory will start seeing evictions — that is the intended bound, but raise it if you were relying on the old behaviour.
- **Redis tag indexes grew forever.** Tag membership was a plain `SET` that nothing ever removed from: `delete` did not unregister the key, and Redis never reports that a member expired. Tags are now **sorted sets** scored by expiry, expired members are pruned on write, and `delete` removes the key from its tags via a reverse index. The namespace moved from `__tags__:` to `__tagz__:`; the old sets are inert orphans — clear them once with `DEL __tags__:*` after upgrading.
- **A cached `undefined` was indistinguishable from a miss.** `remember()` with a factory that legitimately returns `undefined` recomputed on every single call, and `put(key, undefined)` wrote the invalid literal `undefined` to Redis. Undefined values now round-trip through an internal marker; `get()` still reports your fallback for them.
