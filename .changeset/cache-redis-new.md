---
'@basaltkit/cache-redis': major
---

**New package: the Redis driver for `@basaltkit/cache`**, extracted from the
core so consumers who never touch Redis stop installing ioredis.

```bash
pnpm add @basaltkit/cache-redis ioredis
```

```ts
import { redisCache } from '@basaltkit/cache-redis'

cachePlugin({ driver: redisCache(process.env.REDIS_URL!) })
```

Exports `redisCache(url)` and `RedisCacheDriver` — construct the class directly
with an existing `ioredis` instance to share a connection.

The driver code is unchanged from `@basaltkit/cache`; this is a move, and its
tests moved with it, including the glob-injection guard that proves a tenant id
containing `*` or `[` cannot flush another tenant's keys.
