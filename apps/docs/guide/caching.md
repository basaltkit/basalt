# Caching

`@basaltkit/cache` is a tenant-scoped cache with tags, TTL and stampede
protection, over a pluggable driver — in-memory for dev, Redis for production,
or a multi-level driver that puts a near cache in front of Redis.

[[toc]]

## Setup

```ts
import { cachePlugin, CACHE } from '@basaltkit/cache'

cachePlugin({ driver: 'redis', url: process.env.REDIS_URL }) // or 'memory' (default)

const cache = app.container.get(CACHE)
await cache.put('key', value, '10m')
const value = await cache.get('key')
```

Every key is prefixed with the tenant from `ctx().tenant`, so tenants never see
each other's entries. `cache.flush()` clears only this tenant's keys.

## remember

The workhorse — return the cached value or compute, cache and return it, with
per-process stampede protection (concurrent misses share one computation):

```ts
const plans = await cache.remember('plans', '1h', () => db.plans.findMany())
```

## Tags

Group keys and invalidate them together:

```ts
await cache.tags('plans').put('pro', plan, '1h')
await cache.tags('plans').flush()   // drops every key tagged 'plans'
```

## Drivers

`driver` is `'memory'`, `'redis'` (with `url`), or a custom `CacheDriver`
instance.

### Multi-level (tiered)

`@basaltkit/cache-tiered` puts an in-process near cache in front of a shared far
cache (Redis) — hot keys are served from memory, cutting network round-trips,
while Redis stays the source of truth across instances:

```ts
import { cachePlugin, MemoryCacheDriver, RedisCacheDriver } from '@basaltkit/cache'
import { TieredCacheDriver } from '@basaltkit/cache-tiered'

cachePlugin({
  driver: new TieredCacheDriver({
    layers: [new MemoryCacheDriver(), RedisCacheDriver.fromUrl(process.env.REDIS_URL!)],
    backfillTtlMs: 30_000, // how long the near cache keeps a value read from Redis
  }),
})
```

A read checks each layer fastest→slowest, short-circuits on the first hit and
backfills the faster layers; writes and invalidations fan out to all layers. It
has no capability gaps — whatever the layers support (tags, prefix flush), the
tiered driver supports by delegation.

::: tip Cross-instance invalidation
A local invalidation only clears **this** node's near cache. To drop the near
cache everywhere, trigger invalidation from a shared event, or keep
`backfillTtlMs` short to bound staleness.
:::

## Writing a driver

Implement the `CacheDriver` contract — `get`, `set(key, value, ttlMs?, tags?)`,
`delete`, `flushPrefix`, `flushTags`, `disconnect` — and pass the instance as
`driver`. `TieredCacheDriver` is a small reference implementation (it's pure
composition over other drivers).
