# @machize/cache-tiered

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@machize/*` ecosystem.

## 0.24.0

### Patch Changes

- Updated dependencies [be55f2d]
  - @machize/cache@0.24.0

## 0.23.0

### Minor Changes

- fc539f1: New package: `@machize/cache-tiered` — a multi-level cache driver for `@machize/cache`.

  `TieredCacheDriver` puts an in-process near cache in front of a shared far cache (Redis) to cut network round-trips for hot keys, implementing the same `CacheDriver` contract by composition: a read checks each layer fastest→slowest, short-circuits on the first hit and backfills the faster layers it skipped (bounded by `backfillTtlMs`, default 1 minute), while writes and invalidations (`set`/`delete`/`flushPrefix`/`flushTags`) fan out to every layer. No capability gaps — whatever the layers support, the tiered driver supports, since it delegates. Zero dependencies (it composes `MemoryCacheDriver` and `RedisCacheDriver`). Fully unit-tested: write-through, near-hit short-circuit, slow-hit backfill, tag/prefix invalidation across layers.

### Patch Changes

- @machize/cache@0.23.0
