# @basaltkit/cache-tiered

**Multi-level (tiered)** cache driver for [`@basaltkit/cache`](https://www.npmjs.com/package/@basaltkit/cache): puts an in-process *near cache* in front of a shared *far cache* (Redis), cutting network round-trips on hot keys. **Zero dependencies** — it composes the drivers you already have. You need this module when the same data is read many times per request/instance and you want to avoid hitting Redis every time.

## What this module solves

A Redis access is fast, but it's still network. If a key is read hundreds of times, an in-memory cache (L1) in front of Redis (L2) eliminates almost all of those network round-trips — while keeping Redis as the shared source across instances. This driver does that by implementing the **same `CacheDriver` contract**: reads short-circuit at the first layer with a hit and **backfill** the faster layers; writes and invalidations **fan out** to all of them.

## Installation

```bash
pnpm add @basaltkit/cache-tiered @basaltkit/cache
```

No runtime dependencies beyond `@basaltkit/cache`.

## Usage

```ts
import { cachePlugin, MemoryCacheDriver, RedisCacheDriver } from '@basaltkit/cache'
import { TieredCacheDriver } from '@basaltkit/cache-tiered'

cachePlugin({
  driver: new TieredCacheDriver({
    layers: [new MemoryCacheDriver(), RedisCacheDriver.fromUrl(process.env.REDIS_URL!)],
    backfillTtlMs: 30_000, // L1 keeps a value coming from Redis for at most 30s
  }),
})
```

Everything else (`cache.remember`, tags, `flush`) works the same — `TieredCacheDriver` is transparent.

## How it works

- **`get`** — walks the layers (fast → slow); on the first hit, returns it and **backfills** the faster layers that missed (with `backfillTtlMs`, since the remaining TTL isn't known at the slow layer).
- **`set`** — writes to **all** layers with the same TTL and tags.
- **`delete` / `flushPrefix` / `flushTags`** — fan out to all layers.
- **No gaps** — whatever your layers support (tags, flush by prefix), this driver supports, by delegation.

> Cross-instance consistency: local invalidations only clear the L1 of **this** instance. To invalidate L1 across all nodes, trigger the invalidation from a shared event (or use a short `backfillTtlMs` to limit the window of stale data).

## Options

| Option | Default | Description |
|---|---|---|
| `layers` | — (required) | Layers ordered from fastest to slowest, e.g. `[memory, redis]`. |
| `backfillTtlMs` | `60000` | TTL applied when backfilling a fast layer from a slow hit. `null` = no expiration. |

## How it connects to other modules

- **`@basaltkit/cache`** — this is a driver for that package; the API (`Cache`, `cachePlugin`, `remember`, tags) comes from there.
- Composes with `MemoryCacheDriver` and `RedisCacheDriver` (from cache core).
