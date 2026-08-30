<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

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

| Option | Type | Default | Purpose |
|---|---|---|---|
| `prefix` | `string` | `'basalt'` | Root prefix for all keys. Change it when two apps share one Redis, so each owns its own key space and `flush()` can't cross the boundary. |
| `scope` | `(() => string \| undefined) \| null` | reads `ctx().tenant.id` → `tenant:<id>` | Dynamic prefix segment, resolved on **every** operation. Pass `null` for a deliberate global cache; pass your own function to scope by something other than tenant (region, API version). |
| `onMissingScope` | `'global' \| 'error'` | `'error'` when tenancy is active, else `'global'` — see below | What a read/write does when `scope()` resolves `undefined`. `'global'` shares one namespace; `'error'` throws `MissingCacheScopeError`. |
| `now` | `() => number` | `Date.now` | Injectable clock (ms) for the stale-while-revalidate windows. For tests. |

A value of `undefined` is a real cached value, not a miss: `remember()` with a factory that returns `undefined` computes it **once** and serves the cached `undefined` afterwards. `get()` still reports its `fallback` for such an entry, because `get` cannot distinguish "cached undefined" from "absent".

`SwrOptions` (the object form of `remember`'s second argument):

| Field | Type | Purpose |
|---|---|---|
| `ttl` | `DurationInput` | How long the value stays **fresh** — served with no revalidation. |
| `staleFor` | `DurationInput` | Extra window after `ttl` in which a stale value is served instantly while one background revalidation runs. After `ttl + staleFor` the entry is hard-expired and the next read blocks on the factory. The driver TTL is set to `ttl + staleFor`. |

#### `onMissingScope` and the `tenancy:active` interaction

The `Cache` class on its own defaults `onMissingScope` to `'global'`. `cachePlugin` **overrides
that to `'error'`** when three things hold at once:

1. `@basaltkit/tenancy` is registered — it adds a `tenancy:active` marker to the container's
   metadata at register time, and the cache plugin checks for it;
2. you did not pass `onMissingScope`; **and**
3. you did not pass a custom `scope`.

Any explicit `onMissingScope` or `scope` wins — the upgrade only fills a gap you left blank.

The reasoning: in a multi-tenant app, a cache operation that resolves no tenant is a bug almost
every time (a queue worker, a cron task, a startup hook — code running outside a request). Under
`'global'` it doesn't fail; it writes a per-tenant value into the shared namespace, where the
**next tenant reads it**. That is a cross-tenant data leak with no error and no log. Failing
closed turns it into a stack trace at the call site.

Single-tenant apps are untouched: no tenancy plugin, no marker, so the default stays `'global'`
and nothing changes.

```ts
// Multi-tenant: this now throws instead of poisoning the shared namespace.
cachePlugin({ driver: 'redis', url })   // + tenancyPlugin() registered  → onMissingScope: 'error'

// Deliberate global cache — opt out explicitly, and the scope check never runs.
cachePlugin({ driver: 'redis', url, scope: null })

// Keep the old permissive behaviour, knowingly.
cachePlugin({ driver: 'redis', url, onMissingScope: 'global' })
```

**`flush()` always fails closed**, whatever `onMissingScope` says: if `scope` is not `null` and
resolves `undefined`, it throws rather than wiping the whole prefix. A mis-scoped `flush()` under
`'global'` would delete **every tenant's** cache in one call, and no convenience is worth that.
`scope: null` is exempt — you declared the cache global, so its "everything" is genuinely
everything you meant.

To flush one tenant, call it inside that tenant's context; to flush the global namespace of a
tenant-scoped cache, build a second `Cache` with `scope: null`.

### `cachePlugin(options?: CachePluginOptions)`

Registers `Cache` in the container under the `CACHE` token and disconnects the driver on application `shutdown`.

#### Drivers

**`MemoryCacheDriver`** — the default, and **bounded**: cache keys usually embed ids, slugs or query fingerprints, so unbounded growth on user-influenced keys is an OOM vector. It holds at most `maxEntries` live entries (default **10 000**), evicting already-expired entries first and then the least recently used (`get` counts as a use).

| Option | Type | Default | Purpose |
|---|---|---|---|
| `maxEntries` | `number` | `10_000` | Live-entry cap before eviction; `Infinity` disables it. |

It also exposes `size` (live entry count) for diagnostics and tests.

**`RedisCacheDriver`** — values are `JSON.stringify`/`JSON.parse`'d, so store plain data (`Date` comes back as a string; `Map`/class instances do not survive). Two details worth knowing:

- **Prefix flushes are glob-escaped.** The scope segment carries user-controlled data (a tenant id or slug), so `flushPrefix` escapes Redis glob metacharacters (`\ * ? [ ] ^`) before `SCAN MATCH`. Without it, a tenant named `a*` would match — and delete — other tenants' keys.
- **Tag indexes are sorted sets** under `__tagz__:<tag>`, scored by each member's expiry, plus a reverse index `__tagsof__:<key>`. Expired members are pruned on write and `delete` unregisters the key from its tags, so the index tracks the live key set instead of growing forever. Upgrading from the older plain sets (`__tags__:`) leaves inert orphans — clear them once with `DEL __tags__:*`.

#### `CachePluginOptions` (extends `CacheOptions`)

| Option | Type | Default | Purpose |
|---|---|---|---|
| `driver` | `'memory' \| 'redis' \| CacheDriver` | `'memory'` | Built-in driver by name, **or a driver instance** — that is how you plug in [`@basaltkit/cache-tiered`](https://www.npmjs.com/package/@basaltkit/cache-tiered) or your own. An instance is used as-is and `url` is ignored. |
| `url` | `string` | — | Required with `driver: 'redis'`. Redis connection URL (e.g. `redis://localhost:6379`). |
| `prefix`, `scope`, `onMissingScope`, `now` | — | see `CacheOptions` | Inherited from `CacheOptions`. |

The plugin registers the `Cache` as a container singleton and `disconnect()`s the driver on
application `shutdown`.

### `CACHE`

Dependency injection token: `app.container.get(CACHE)` returns the `Cache` instance.

### Errors

| Error | Code | When |
|---|---|---|
| `MissingCacheScopeError` | `CACHE_SCOPE_MISSING` | A tenant-scoped cache resolved no tenant. Raised on a read/write when `onMissingScope: 'error'` (the default once tenancy is registered), and **always** on `flush()` regardless of `onMissingScope`. Extends `BasaltError`. The message names the operation and tells you to establish a tenant or pass `scope: null`. |
| `DURATION_INVALID` (from `@basaltkit/core`) | `DURATION_INVALID` | A TTL string that `parseDuration` doesn't understand. Accepted forms: a number of ms, or `'500ms'` / `'30s'` / `'5m'` / `'2h'` / `'7d'`. |

There are no other error classes: driver-level faults (a Redis connection error) propagate from
`ioredis` unchanged.

### Hooks & events

This package emits none. `onMissingScope` is a policy switch, not a callback, and there is no
hit/miss event bus — measure at the `remember` call site if you need cache metrics.

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

**`CACHE_SCOPE_MISSING` — "Refusing cache operation: a tenant-scoped cache resolved no tenant".**
Cache code ran outside a tenant context — usually a queue worker, a scheduled task, or a boot hook. Establish the tenant around the call (`runWithContext({ tenant: { id } }, …)`), or, if the value really is global, use a cache built with `scope: null`. Do **not** reach for `onMissingScope: 'global'` to make it go away: that is what makes one tenant's value readable by the next.

**`CACHE_SCOPE_MISSING` on `flush()` even though `onMissingScope` is `'global'`.**
Deliberate. `flush()` always fails closed, because a mis-scoped whole-namespace wipe would delete every tenant's cache. Only `scope: null` exempts it.

**I configured `driver: 'redis'` and the application fails to boot/use the cache.**
With `driver: 'redis'`, the `url` option is required. Also verify that the Redis server is reachable at that URL.

## How it connects to other modules

- **`@basaltkit/core`** — provides `createApp`, the dependency container, the request context (`ctx`/`runWithContext`) from which tenant isolation comes, and the `parseDuration` used for TTLs.
- **`@basaltkit/tenancy`** — when the tenancy plugin identifies the request's tenant and puts it in the context, the cache automatically starts isolating keys per tenant.
- **`@basaltkit/prisma`** — pairs well with `cache.remember(...)` to store the results of expensive database queries.
- **`@basaltkit/flags`, `@basaltkit/permissions`, etc.** — any module can get the cache via `container.get(CACHE)` to speed up its own operations.
