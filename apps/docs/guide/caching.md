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

::: warning Fail-closed outside tenant context (multi-tenant apps)
When `tenancyPlugin` is registered, a cache operation with **no resolvable
tenant scope** — a background job or boot task running outside request context —
throws `MissingCacheScopeError` instead of silently reading and writing one
namespace shared across all tenants. Single-tenant apps (no tenancy plugin) are
unaffected. To run a job for a specific tenant, wrap it in
`runWithContext({ tenant })`; if cross-tenant sharing is genuinely intended,
opt back in with `cachePlugin({ onMissingScope: 'global' })`.
:::

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

### Stale-while-revalidate (SWR)

Pass `{ ttl, staleFor }` instead of a plain TTL and `remember` trades a bounded
amount of staleness for never blocking a hot read on the factory:

```ts
// Fresh for 1 minute; for the next 10 minutes a stale copy is served
// instantly while ONE background refresh runs.
const stats = await cache.remember(
  'dashboard-stats',
  { ttl: '1m', staleFor: '10m' },
  () => computeExpensiveStats(),
)
```

A read lands in one of three windows:

| Window | Age of entry | Behaviour |
| --- | --- | --- |
| Fresh | `< ttl` | Served from cache, factory never runs |
| Stale | `ttl` … `ttl + staleFor` | Served **immediately**, one background revalidation refreshes the entry |
| Expired | `> ttl + staleFor` | Hard miss — the read blocks on the factory like a plain `remember` |

Background revalidation reuses the same per-process dedupe as stampede
protection — at most one refresh per key is in flight, and a failed refresh
keeps serving the stale value (it never surfaces as an unhandled rejection).
SWR entries are stored as a small envelope carrying the freshness windows; the
driver-level TTL is `ttl + staleFor`, so an expired entry really disappears. A
raw value written by `put()` or a plain `remember` is served as fresh —
switching a key to SWR needs no migration.

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

### The memory driver is bounded

`MemoryCacheDriver` is the default, so it must not grow without limit: cache
keys usually embed ids, slugs or query fingerprints, and unbounded growth on
user-influenced keys is an OOM waiting to happen. It holds at most **10 000
entries**, evicting already-expired ones first and then the least recently used
(`get` counts as a use, so hot keys survive).

```ts
import { MemoryCacheDriver, cachePlugin } from '@basaltkit/cache'

cachePlugin({ driver: new MemoryCacheDriver({ maxEntries: 50_000 }) })
cachePlugin({ driver: new MemoryCacheDriver({ maxEntries: Infinity }) }) // no cap
```

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `maxEntries` | `number` | `10_000` | Live-entry cap before eviction; `Infinity` disables it |

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

::: tip Cross-instance staleness is bounded by `backfillTtlMs`
There is no invalidation bus between instances — instead, **every write to a
near layer is clamped to `backfillTtlMs`** (both read backfills and direct
`set()`s; the last, shared layer keeps the full TTL). After another replica
updates or deletes a key, no instance serves its local copy for longer than
this bound. Keep it short for hot-changing data; `backfillTtlMs: null` removes
the bound entirely and is only safe single-replica.
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


## Options reference

`cachePlugin(options)` — everything is optional:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `driver` | `'memory' \| 'redis' \| CacheDriver` | `'memory'` | Storage backend; pass an instance for tiered/custom drivers |
| `url` | `string` | — | Redis connection URL — **required** with `driver: 'redis'` |
| `prefix` | `string` | `'basalt'` | Root prefix for every key |
| `scope` | `(() => string \| undefined) \| null` | reads `ctx().tenant.id` → `tenant:<id>` | Dynamic prefix segment resolved on every operation — the per-tenant isolation. `null` = a deliberate **global** cache (no scoping, no fail-closed) |
| `onMissingScope` | `'global' \| 'error'` | see below | What a read/write does when the scope fn resolves nothing: `'global'` shares one namespace, `'error'` throws `MissingCacheScopeError`. `flush()` **always** fails closed, regardless |
| `now` | `() => number` | `Date.now` | Injectable clock for the SWR freshness windows (tests) |

**How the `onMissingScope` default is chosen.** When
[`tenancyPlugin`](/guide/tenancy) is registered, it publishes a
`'tenancy:active'` metadata marker; `cachePlugin` reads it and defaults to
`'error'` — a multi-tenant app fails closed instead of silently sharing one
namespace across tenants. Without the marker (single-tenant app) the default
stays `'global'`. An explicit `onMissingScope` value or a custom `scope`
function always wins over this detection.

## Failure modes & troubleshooting

| Error | Code | When |
| --- | --- | --- |
| `MissingCacheScopeError` | `CACHE_SCOPE_MISSING` | A tenant-scoped cache resolved no tenant: any read/write with `onMissingScope: 'error'` (the default under `tenancyPlugin`), and **every** `flush()` with an unresolved scope |

- **`CACHE_SCOPE_MISSING` from a background job, seed script or boot task** —
  the code runs outside a request, so no tenant was resolved. Run it inside a
  tenant context (`tenancy.run(tenantId, …)` /
  `runWithContext({ tenant })`), or — only if the data is genuinely shared —
  opt out with `onMissingScope: 'global'` or a dedicated `scope: null` cache.
- **`flush()` throws even with `onMissingScope: 'global'`** — intended: with no
  scope resolved, a flush would wipe the whole namespace, i.e. **every**
  tenant's keys at once, so it always fails closed. Only `scope: null` (a
  deliberately global cache) flushes without a tenant.
- **Values come back subtly wrong on Redis** — JSON round-trip: `Date`
  becomes a string, `Map`/class instances don't survive. Store plain data (see
  the warning under [Drivers](#drivers)).
- **The factory runs more often than expected across a fleet** — stampede
  dedupe and SWR revalidation are **per process**; two replicas may compute
  concurrently. Within one process a key computes exactly once.
- **Entries disappear before their TTL on the memory driver** — you are past
  `maxEntries` (10 000 by default) and the LRU is evicting. Raise the cap, or
  move to Redis.
- **A factory returning `undefined` used to rerun every call** — it doesn't any
  more: `undefined` is stored behind an internal marker, so it is a real cache
  hit. `cache.get(key, fallback)` still returns your fallback for it, because a
  cached `undefined` and a miss are indistinguishable through `get`.
- **Redis tag flushes stopped matching after an upgrade** — tag indexes moved
  from plain sets (`__tags__:`) to sorted sets scored by expiry (`__tagz__:`),
  so expired members are pruned instead of accumulating forever. The old keys
  are inert orphans; clear them once with `DEL __tags__:*`.


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
