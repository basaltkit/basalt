# @basaltkit/cache

Basalt's cache layer: stores the results of slow operations (database queries, external API calls, heavy computations) so they can be returned instantly next time. You need this module when your application repeats the same work over and over and you want to make it faster and cheaper.

## What this module solves

**Cache** is temporary memory: instead of fetching the same information from the database (or an external API) on every request, you store the result once and reuse it for a period of time. That period is called the **TTL** (*time to live*) — once it passes, the value expires and is recomputed.

This module gives you a `Cache` class with a simple API (`get`, `put`, `remember`, `forget`, `flush`, `tags`) that works over two interchangeable **drivers**: **memory** (inside the Node.js process itself — ideal for development and testing) and **Redis** (an external cache server, shared across multiple processes — ideal for production).

It also solves three problems that are normally a hassle:

1. **Tenant isolation** — in a multi-tenant SaaS application (several customers/organizations in the same app), each tenant sees only its own cache entries, automatically, without you having to compose keys by hand.
2. **Stampede protection** — if 100 requests arrive at the same time and the value is not cached, the expensive function runs **exactly once**; the other 99 requests wait and receive the same result.
3. **Tag-based invalidation** — you can group related entries (e.g. everything related to "plans") and clear them all at once with a single line.

## Installation

```bash
pnpm add @basaltkit/cache
```

The package depends on `@basaltkit/core` (the framework core) and already includes the Redis client (`ioredis`) — you don't need to install anything else.

## Getting started in 5 minutes

Step by step, from zero to having a working cache:

1. **Create the app and register the plugin.** `cachePlugin` registers a `Cache` instance in the application's dependency container (the "container" is where Basalt keeps its shared services).

2. **Get the cache via the `CACHE` token** and use it.

```ts
import { createApp } from '@basaltkit/core'
import { CACHE, cachePlugin } from '@basaltkit/cache'

// 1. Register the plugin (driver 'memory' — no external servers needed)
const app = await createApp({
  plugins: [cachePlugin({ driver: 'memory' })],
}).boot()

// 2. Get the Cache instance
const cache = app.container.get(CACHE)

// 3. Store a value for 5 minutes
await cache.put('greeting', 'hello world', '5m')

// 4. Read the value (returns undefined if it doesn't exist or has expired)
console.log(await cache.get('greeting')) // 'hello world'

// 5. At the end of the application, shut everything down (the driver is disconnected)
await app.shutdown()
```

For production with Redis, just change the plugin options:

```ts
import { cachePlugin } from '@basaltkit/cache'

cachePlugin({ driver: 'redis', url: 'redis://localhost:6379' })
```

## Usage guide

### Reading and writing values (`get` / `put`)

```ts
import { Cache, MemoryCacheDriver } from '@basaltkit/cache'

const cache = new Cache(new MemoryCacheDriver())

await cache.put('config', { theme: 'dark' })         // no TTL: stays until deleted
await cache.put('session', 'abc123', '30s')          // expires in 30 seconds
await cache.put('token', 'xyz', 60_000)              // TTL also accepts milliseconds

await cache.get('config')                            // { theme: 'dark' }
await cache.get('missing')                           // undefined
await cache.get('missing', 'default-value')          // 'default-value' (fallback)
```

TTLs accept a number in milliseconds **or** a human-readable string: `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'7d'`.

### `remember` — the most useful pattern (cache-aside in one line)

Instead of writing "check if it's cached; if not, compute and store it", `remember` does all of that for you — with stampede protection (concurrent calls for the same key share **one** execution of the function):

```ts
import { Cache, MemoryCacheDriver } from '@basaltkit/cache'

const cache = new Cache(new MemoryCacheDriver())

const plans = await cache.remember('plans', '1h', async () => {
  // This function only runs when the value is NOT cached.
  return fetchPlansFromDatabase()
})
```

### Stale-while-revalidate (serve fast, refresh in the background)

For values that are expensive to build but tolerate being *slightly* out of date
(dashboards, feeds, pricing pages), pass `{ ttl, staleFor }` instead of a plain
TTL. The value is **fresh** for `ttl`; for a further `staleFor` window a read gets
the **stale** value **instantly** while a single background revalidation refreshes
it. Only after `ttl + staleFor` does a read block on the factory again:

```ts
const feed = await cache.remember('feed', { ttl: '1m', staleFor: '10m' }, () => buildFeed())
//  0–1m   → fresh, served from cache
//  1–11m  → stale value returned immediately; ONE background refresh runs
//  > 11m  → hard-expired; the next read blocks and recomputes
```

No caller ever waits for a refresh during the stale window, and concurrent stale
reads trigger only **one** background revalidation (same stampede protection as
`remember`). If a background refresh throws, the stale value keeps being served
until it hard-expires — a failing upstream never turns into an error for the user.
Works with `tags(...)` too: `cache.tags('feed').remember(key, { ttl, staleFor }, fn)`.

### Deleting entries (`forget` / `flush`)

```ts
await cache.forget('plans')   // deletes a key; returns true if it existed
await cache.flush()           // deletes ALL keys in this prefix/scope
                              // (never wipes the whole Redis instance — only your keys)
```

### Tags — invalidating groups of entries

A **tag** is a label that associates several entries with the same group. When the source data changes, you invalidate the whole group:

```ts
import { Cache, MemoryCacheDriver } from '@basaltkit/cache'

const cache = new Cache(new MemoryCacheDriver())

await cache.tags('plans').put('plan:free', { price: 0 })
await cache.tags('plans').put('plan:pro', { price: 29 })
await cache.put('something-else', 'stays')

// remember also works with tags:
await cache.tags('plans').remember('plan:enterprise', '1h', () => fetchPlan('enterprise'))

// Someone changed the plans? Invalidate the whole group:
await cache.tags('plans').flush()

await cache.get('plan:free')     // undefined
await cache.get('something-else') // 'stays' (didn't have the tag)
```

### Automatic tenant isolation

If your application uses Basalt's tenancy system, every cache operation reads the tenant from the **request context** (`ctx().tenant.id`) and prefixes keys with `tenant:<id>`. Each tenant thus gets its own "drawer" — no extra code required:

```ts
import { runWithContext } from '@basaltkit/core'
import { Cache, MemoryCacheDriver } from '@basaltkit/cache'

const cache = new Cache(new MemoryCacheDriver())

await runWithContext({ tenant: { id: 'acme' } }, () => cache.put('config', 'from-acme'))
await runWithContext({ tenant: { id: 'globex' } }, () => cache.put('config', 'from-globex'))
await cache.put('config', 'central') // outside any tenant

await runWithContext({ tenant: { id: 'acme' } }, () => cache.get('config')) // 'from-acme'
await cache.get('config')                                                   // 'central'

// flush() on one tenant does not touch other tenants or the central space
await runWithContext({ tenant: { id: 'acme' } }, () => cache.flush())
```

In normal HTTP requests you don't need to call `runWithContext` — the framework does it for you. To disable isolation, pass `scope: null` in the options.

### Using an existing Redis driver (Advanced)

```ts
import { Redis } from 'ioredis'
import { Cache, RedisCacheDriver } from '@basaltkit/cache'

// From a URL:
const cacheA = new Cache(RedisCacheDriver.fromUrl('redis://localhost:6379'))

// Or reusing your own ioredis connection:
const redis = new Redis('redis://localhost:6379')
const cacheB = new Cache(new RedisCacheDriver(redis))
```

## API reference

### `class Cache`

`new Cache(driver: CacheDriver, options?: CacheOptions)`

| Method | Signature | Description |
|---|---|---|
| `get` | `get<T>(key: string): Promise<T \| undefined>` / `get<T>(key: string, fallback: T): Promise<T>` | Reads a value; returns `undefined` (or the `fallback`) on miss/expiration. |
| `put` | `put(key: string, value: unknown, ttl?: DurationInput): Promise<void>` | Stores a value, with an optional TTL. |
| `remember` | `remember<T>(key, ttl: DurationInput, factory): Promise<T>` — or `remember<T>(key, { ttl, staleFor }: SwrOptions, factory)` | Cache-aside with stampede protection. With `{ ttl, staleFor }` it becomes stale-while-revalidate: serves a stale value while refreshing once in the background. |
| `forget` | `forget(key: string): Promise<boolean>` | Deletes a key; `true` if it existed. |
| `flush` | `flush(): Promise<void>` | Deletes all keys in the current prefix/scope. |
| `tags` | `tags(...tags: string[])` | Returns an object with `put`, `remember` and `flush` scoped to the given tags. |

#### `CacheOptions`

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `prefix` | `string` | No | `'basalt'` | Root prefix for all keys. |
| `scope` | `(() => string \| undefined) \| null` | No | reads `ctx().tenant.id` → `tenant:<id>` | Dynamic prefix segment, resolved on each operation. `null` disables tenant isolation. |

### `cachePlugin(options?: CachePluginOptions)`

Registers `Cache` in the container under the `CACHE` token and disconnects the driver on application `shutdown`.

#### `CachePluginOptions` (extends `CacheOptions`)

| Option | Type | Required? | Default | Description |
|---|---|---|---|---|
| `driver` | `'memory' \| 'redis'` | No | `'memory'` | Which driver to use. |
| `url` | `string` | Yes, with `driver: 'redis'` | — | Redis connection URL (e.g. `redis://localhost:6379`). |
| `prefix`, `scope` | — | No | see `CacheOptions` | Inherited from `CacheOptions`. |

### `CACHE`

Dependency injection token: `app.container.get(CACHE)` returns the `Cache` instance.

### `interface CacheDriver` (Advanced)

Contract that any driver must implement — implement it to create your own storage:

| Method | Signature | Description |
|---|---|---|
| `get` | `get(key: string): Promise<unknown>` | `undefined` on miss/expiration. |
| `set` | `set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void>` | Stores the value (TTL in milliseconds). |
| `delete` | `delete(key: string): Promise<boolean>` | Deletes a key. |
| `flushPrefix` | `flushPrefix(prefix: string): Promise<void>` | Deletes all keys starting with the prefix. |
| `flushTags` | `flushTags(tags: string[]): Promise<void>` | Deletes all keys associated with any of the tags. |
| `disconnect` | `disconnect(): Promise<void>` | Releases resources/connections. |

### `class MemoryCacheDriver` (Advanced)

`new MemoryCacheDriver()` — stores everything in a `Map` inside the process. No options. Perfect for development and testing; data is lost when the process ends and is not shared across processes.

### `class RedisCacheDriver` (Advanced)

| Member | Signature | Description |
|---|---|---|
| constructor | `new RedisCacheDriver(redis: Redis)` | Takes an already-created `ioredis` instance. |
| `fromUrl` | `static fromUrl(url: string): RedisCacheDriver` | Creates the connection from a URL. |

Values are serialized with `JSON.stringify`/`JSON.parse` — you can only store JSON-serializable values (no functions, `Date` becomes a string, etc.).

## Common errors and solutions (FAQ)

**`get` always returns `undefined` after I did a `put`.**
The `put` and `get` probably ran in different tenant contexts (or one inside and one outside a tenant) — the keys end up under different prefixes. Check the context, or pass `scope: null` if you don't want isolation.

**`DURATION_INVALID` error when passing a TTL.**
The TTL must be a number (milliseconds) or a string in the format `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'7d'`. `'5 minutos'` or `'1w'` are not accepted.

**I stored an object in Redis and got back something "different".**
The Redis driver serializes to JSON. Class instances, `Date`, `Map`, functions — all of that is lost or turned into a JSON representation. Store plain data (objects, arrays, strings, numbers, booleans).

**Stampede protection doesn't work across servers.**
This is by design: `remember`'s deduplication is **per process** (it uses an in-memory map of in-flight promises). Two different servers can run the factory at the same time — but within each server it runs only once.

**`flush()` deleted less than I expected.**
`flush()` only deletes keys under the current prefix + scope (that's the safety guarantee: it never does `FLUSHALL` on Redis). To clear a tenant's keys, call `flush()` inside that tenant's context.

**I configured `driver: 'redis'` and the application fails to boot/use the cache.**
With `driver: 'redis'`, the `url` option is required. Also verify that the Redis server is reachable at that URL.

## How it connects to other modules

- **`@basaltkit/core`** — provides `createApp`, the dependency container, the request context (`ctx`/`runWithContext`) from which tenant isolation comes, and the `parseDuration` used for TTLs.
- **`@basaltkit/tenancy`** — when the tenancy plugin identifies the request's tenant and puts it in the context, the cache automatically starts isolating keys per tenant.
- **`@basaltkit/prisma`** — pairs well with `cache.remember(...)` to store the results of expensive database queries.
- **`@basaltkit/flags`, `@basaltkit/permissions`, etc.** — any module can get the cache via `container.get(CACHE)` to speed up its own operations.
