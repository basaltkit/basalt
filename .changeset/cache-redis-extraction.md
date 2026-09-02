---
'@basaltkit/cache': major
---

## ⚠️ BREAKING — the Redis driver moved to `@basaltkit/cache-redis`

`@basaltkit/cache` hard-depended on `ioredis` — about **1.5 MB** — so every
consumer installed it, including apps running only the in-memory driver and
consumers of `@basaltkit/cache-tiered`.

### Migration

```bash
pnpm add @basaltkit/cache-redis ioredis
```

```diff
+import { redisCache } from '@basaltkit/cache-redis'

-cachePlugin({ driver: 'redis', url: process.env.REDIS_URL })
+cachePlugin({ driver: redisCache(process.env.REDIS_URL!) })
```

`RedisCacheDriver` is re-exported from the new package, so
`cachePlugin({ driver: new RedisCacheDriver(redis) })` keeps working after
changing the import.

**Unaffected:** apps using the default in-memory driver, or passing any other
`CacheDriver` instance. `memory` stays in the core — it needs no client library.

### What this leaves behind

`CachePluginOptions.driver` is now `'memory' | CacheDriver`, and the `url` option
is gone with the shorthand that needed it. `@basaltkit/cache` depends on nothing
but `@basaltkit/core`, and the repo-wide driver-boundary tripwire no longer needs
it in its allowlist — that KNOWN DEBT entry is deleted, because the debt is paid.
