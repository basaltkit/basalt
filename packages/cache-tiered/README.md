<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

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
    backfillTtlMs: 30_000, // no replica serves a local copy older than 30s
  }),
})
```

Everything else (`cache.remember`, tags, `flush`) works the same — `TieredCacheDriver` is transparent.

## How it works

- **`get`** — walks the layers (fast → slow); on the first hit, returns it and **backfills** every faster layer that missed, writing it with `backfillTtlMs` (the slow layer can't tell you how much of the original TTL is left).
- **`set`** — writes to **all** layers, in parallel, with the same value and tags. The **last** layer gets the caller's TTL verbatim; every layer before it gets the *clamped* TTL. See below.
- **`delete` / `flushPrefix` / `flushTags`** — fan out to all layers. `delete` returns `true` if any layer had the key.
- **`disconnect`** — fans out too, so `cachePlugin`'s shutdown closes every layer.
- **No gaps** — whatever your layers support (tags, flush by prefix), this driver supports, by delegation.

## The `backfillTtlMs` clamp

This is the one thing to understand before deploying a tiered cache on more than one replica.

**What it is clamped to:** every write to a **near** layer — that is, every layer except the
last — gets `Math.min(callerTtl, backfillTtlMs)`. If the caller passed no TTL at all, the near
layers get `backfillTtlMs` rather than "forever". The **last** layer (the shared one, Redis) is
never clamped: it keeps exactly the TTL the caller asked for. The clamp applies to both paths —
read backfills *and* direct `set()`s.

```
cache.put('plans', value, '1h')   with backfillTtlMs: 30_000
  → memory layer (near):  30s     ← clamped
  → redis layer  (last):  1h      ← the caller's TTL, untouched
```

**Why it exists:** there is no cross-replica invalidation bus. When replica B updates or deletes
`plans`, it writes to the shared Redis and to *its own* memory — it has no way to reach into
replica A's process memory. Without the clamp, replica A would keep serving its local copy for
the full hour, long after the value became wrong. Nothing would ever correct it.

The clamp bounds that window. `backfillTtlMs` **is** the coherence contract: it is the maximum
staleness any replica can exhibit after another replica changed a key. Pick it as a staleness
budget, not as a performance knob — 30 s means "a user may see up to 30 s-old data after someone
else edits it".

`backfillTtlMs: null` removes the bound entirely: near layers then keep the caller's full TTL and
a stale local copy can survive indefinitely. It is only safe on a genuinely single-replica
deployment.

## Options

| Option | Type | Default | Purpose |
|---|---|---|---|
| `layers` | `CacheDriver[]` | — (required) | Layers ordered fastest → slowest, e.g. `[memory, redis]`. At least one is required. The **last** layer is treated as the shared source of truth and is the only one exempt from the TTL clamp. |
| `backfillTtlMs` | `number \| null` | `60_000` (1 minute) | Upper bound, in ms, on how long the near layers keep an entry — applied to read backfills **and** clamped onto direct writes to every layer except the last. This is your maximum cross-replica staleness. `null` removes the bound (single-replica only). |

## Errors

| Error | Code | When |
|---|---|---|
| `Error: TieredCacheDriver needs at least one layer.` | — (plain `Error`) | The constructor was given an empty `layers` array. |

The driver defines no `BasaltError` subclasses and swallows nothing: a layer that throws
propagates to the caller, so a `set` fails if any layer fails. Scope errors
(`MissingCacheScopeError` / `CACHE_SCOPE_MISSING`) come from the `Cache` in front of this driver,
not from here.

## Hooks & events

None. The driver has no callbacks — it is a pure `CacheDriver` composition.

## How it connects to other modules

- **`@basaltkit/cache`** — this is a driver for that package; the API (`Cache`, `cachePlugin`, `remember`, tags) comes from there.
- Composes with `MemoryCacheDriver` and `RedisCacheDriver` (from cache core).
