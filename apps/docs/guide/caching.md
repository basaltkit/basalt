# Caching

`@basaltkit/cache` is a tenant-scoped cache with tags, TTL and stampede
protection, over a pluggable driver — in-memory for dev, Redis for production,
or a multi-level driver that puts a near cache in front of Redis.

[[toc]]

## Setup

`cachePlugin` registers a `Cache` under the `CACHE` token. Start on the
in-memory driver (no server needed):

```ts
import { createApp } from '@basaltkit/core'
import { cachePlugin, CACHE } from '@basaltkit/cache'

const app = await createApp({
  plugins: [cachePlugin({ driver: 'memory' })], // 'memory' is the default
}).boot()

const cache = app.container.get(CACHE)
await cache.put('greeting', 'hello world', '10m')
console.log(await cache.get('greeting')) // 'hello world'
```

Every key is prefixed with the tenant from `ctx().tenant`, so tenants never see
each other's entries. `cache.flush()` clears only this tenant's keys — it never
does a `FLUSHALL`.

## get / put

```ts
await cache.put('config', { theme: 'dark' })   // no TTL: stays until deleted
await cache.put('session', 'abc123', '30s')    // string durations: 500ms 30s 5m 2h 7d
await cache.put('token', 'xyz', 60_000)        // …or milliseconds

await cache.get('config')                      // { theme: 'dark' }
await cache.get('missing')                     // undefined
await cache.get('missing', 'default-value')    // 'default-value' (fallback on miss)
```

## remember

The workhorse — return the cached value or compute, cache and return it, with
per-process stampede protection (concurrent misses share one computation):

```ts
const plans = await cache.remember('plans', '1h', () => db.plans.findMany())
```

::: tip
Stampede deduplication is **per process** — it uses an in-memory map of in-flight
promises. Two servers can still run the factory at the same time, but within one
process it runs exactly once even under 100 concurrent misses.
:::

## forget / flush

```ts
await cache.forget('plans')  // delete one key; returns true if it existed
await cache.flush()          // delete every key in this tenant's scope
```

## Tags

Group keys and invalidate them together:

```ts
await cache.tags('plans').put('pro', plan, '1h')
await cache.tags('plans').remember('enterprise', '1h', () => fetchPlan('enterprise'))
await cache.tags('plans').flush()   // drops every key tagged 'plans'
```

## Drivers

`driver` is `'memory'`, `'redis'` (with `url`), or a custom `CacheDriver`
instance.

### Swap memory → Redis

Production is a one-line change — point at a Redis server:

```ts
cachePlugin({ driver: 'redis', url: process.env.REDIS_URL }) // e.g. redis://localhost:6379
```

::: warning
With `driver: 'redis'` the `url` option is required, and Redis serializes values
with `JSON.stringify`/`JSON.parse` — store plain data. Class instances, `Map`,
and `Date` don't survive the round-trip (a `Date` comes back as a string).
:::

To reuse an existing `ioredis` connection instead of a URL, pass a
`RedisCacheDriver` instance:

```ts
import { Redis } from 'ioredis'
import { cachePlugin, RedisCacheDriver } from '@basaltkit/cache'

const redis = new Redis(process.env.REDIS_URL!)
cachePlugin({ driver: new RedisCacheDriver(redis) })
// or from a URL: RedisCacheDriver.fromUrl(process.env.REDIS_URL!)
```

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
    backfillTtlMs: 30_000, // how long the near cache keeps a value read from Redis (default 60000)
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

Implement the `CacheDriver` contract and pass the instance as `driver`:

```ts
import type { CacheDriver } from '@basaltkit/cache'

class MyCacheDriver implements CacheDriver {
  async get(key: string): Promise<unknown> { /* undefined on miss/expiry */ return undefined }
  async set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void> { /* … */ }
  async delete(key: string): Promise<boolean> { /* … */ return false }
  async flushPrefix(prefix: string): Promise<void> { /* delete keys under prefix */ }
  async flushTags(tags: string[]): Promise<void> { /* delete keys tagged with any */ }
  async disconnect(): Promise<void> { /* release connections */ }
}
```

`TieredCacheDriver` is a small reference implementation — it's pure composition
over other drivers.


## Conditional requests (ETags)

Separate from the cache above — an HTTP-level optimisation that skips re-sending an
unchanged response. Opt a route in with `meta: { etag: true }`: the framework hashes
the `GET`/`HEAD` response into a strong `ETag`, and when the client sends a matching
`If-None-Match` it replies `304 Not Modified` with no body. Adapter-agnostic
(fastify/express/hono), no handler changes.

```ts
route({
  method: 'GET',
  url: '/projects/:id',
  meta: { etag: true }, // ← ETag + 304 handling
  params: z.object({ id: z.string() }),
  async handler({ params }) { return db.projects.find(params.id) },
})
```

The client caches by `ETag` and revalidates cheaply — you save serialization and
bandwidth on unchanged reads. `computeEtag(body)` and `ifNoneMatchSatisfied(header,
etag)` are exported for custom flows.
