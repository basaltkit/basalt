<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/cache-redis

**Redis** driver for [`@basaltkit/cache`](https://www.npmjs.com/package/@basaltkit/cache) — a cache shared across processes, with atomic stale-while-revalidate and tag invalidation.

## What this module solves

`@basaltkit/cache` gives you tags, SWR and automatic tenant scoping over a driver. The in-memory driver in the core is per-process: fine for one node, wrong the moment you run two.

This package is the Redis driver. It used to live in the core, reachable as `driver: 'redis'`, which meant **every** consumer installed ioredis — about **1.5 MB** — including apps that only ever used the in-memory driver.

## Installation

```bash
pnpm add @basaltkit/cache @basaltkit/cache-redis ioredis
```

`ioredis` is a **peer dependency**: you install it explicitly, which keeps it out of everyone else's tree.

## Get started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { cachePlugin, CACHE } from '@basaltkit/cache'
import { redisCache } from '@basaltkit/cache-redis'

const app = await createApp({
  plugins: [cachePlugin({ driver: redisCache(process.env.REDIS_URL!) })],
}).boot()

const cache = app.container.get(CACHE)
await cache.put('plans', plans, '1h')
const value = await cache.remember('plans', '1h', () => loadPlans())
```

### Reusing a connection you already have

```ts
import { Redis } from 'ioredis'
import { RedisCacheDriver } from '@basaltkit/cache-redis'

cachePlugin({ driver: new RedisCacheDriver(existingRedis) })
```

## API reference

| Export | What |
|---|---|
| `redisCache(url)` | The driver from a connection URL — `redis://` or `rediss://` |
| `RedisCacheDriver` | The driver class; construct it with an `ioredis` instance to share a connection |

Values are serialized with `JSON.stringify`/`JSON.parse`, so store plain data: class instances, `Map` and `Date` do not survive the round trip.

## Multi-tenant safety

When `@basaltkit/tenancy` is registered, the cache fails closed — an operation with no resolvable tenant scope throws rather than silently sharing one namespace across tenants. That behaviour lives in the core and applies to this driver like any other.

Tenant ids are escaped before they reach a Redis glob, so an id containing `*`, `?`, `[` or `\` cannot flush another tenant's keys. That is asserted by this package's tests.

## How it connects to other modules

- **`@basaltkit/cache`** — this is a driver for that package; the whole cache API comes from there.
- [`@basaltkit/cache-tiered`](https://www.npmjs.com/package/@basaltkit/cache-tiered) layers memory in front of a shared driver like this one, and the [Caching](https://basaltkit-docs.pages.dev/guide/caching) guide covers both.
