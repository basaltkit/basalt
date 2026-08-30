# @basaltkit/cache-tiered

## 1.1.1

### Patch Changes

- 104cfb3: Package-manifest hygiene: a uniform `engines.node`, `sideEffects: false` everywhere, and one zod range.
  
  Three metadata inconsistencies the ecosystem review surfaced, fixed in one sweep — no runtime code changes.
  
  - **`engines.node` was declared on 11 of 85 packages.** Only the `*-sqlite` ones carried `>=22.5.0` (they need `node:sqlite`); the other 74 declared nothing, so `npm install` could not warn anyone on an unsupported runtime. Every package now declares `>=22.5.0` — the floor CI actually exercises, and the floor the sqlite packages already required.
  - **`sideEffects` was absent from all 85.** No package relies on import-time side effects (there is not a single bare `import '@basaltkit/…'` in the tree), so every one now declares `"sideEffects": false` and bundlers can drop unused imports from an app's build.
  - **zod range divergence.** 42 packages allowed `^3.24.0 || ^4.0.0`; `@basaltkit/ai` and `@basaltkit/create-app` pinned `^4.0.0` alone — the only external-dependency inconsistency in the monorepo, and enough to force a duplicate zod into an app that is still on 3.x. Both now use the shared range.
- Updated dependencies [104cfb3]
- Updated dependencies [104cfb3]
  - @basaltkit/cache@1.4.0

## 1.1.0

### Minor Changes

- a76d591: **Advisory — `backfillTtlMs` is now a real cross-replica staleness bound: direct writes to the near layers are clamped to it.**
  
  `set()` used to write the entry's **full TTL** into every layer, including the in-process near cache. With multiple replicas (no invalidation bus exists), a replica that wrote a key kept serving its local copy for the entire TTL — hours — after another replica updated or deleted it, far beyond the documented near-cache bound. Now every layer **except the last (shared) one** is clamped to `backfillTtlMs` (default 60 s), the same bound already applied to read backfills; the far cache keeps the caller's TTL and remains the source of truth.
  
  - Verified by a two-replica test: after replica A updates a key, replica B serves the new value within `backfillTtlMs` even for keys B wrote itself.
  - **Trade-off:** hot keys re-read the far cache once per bound per replica (one extra Redis GET/min by default) in exchange for bounded staleness.
  - `backfillTtlMs: null` still opts out entirely (single-replica deployments) — that now disables the coherence bound too, and is documented as such.
  
  A pub/sub invalidation bus (near-instant coherence) was considered and deliberately not built: the bound already expresses the tier contract, and a bus adds a subscriber lifecycle + a new driver contract for an edge the bound covers. It remains a possible future opt-in.

### Patch Changes

- Updated dependencies [a76d591]
  - @basaltkit/cache@1.3.0

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- Updated dependencies [be55f2d]
  - @basaltkit/cache@0.24.0

## 0.23.0

### Minor Changes

- fc539f1: New package: `@basaltkit/cache-tiered` — a multi-level cache driver for `@basaltkit/cache`.

  `TieredCacheDriver` puts an in-process near cache in front of a shared far cache (Redis) to cut network round-trips for hot keys, implementing the same `CacheDriver` contract by composition: a read checks each layer fastest→slowest, short-circuits on the first hit and backfills the faster layers it skipped (bounded by `backfillTtlMs`, default 1 minute), while writes and invalidations (`set`/`delete`/`flushPrefix`/`flushTags`) fan out to every layer. No capability gaps — whatever the layers support, the tiered driver supports, since it delegates. Zero dependencies (it composes `MemoryCacheDriver` and `RedisCacheDriver`). Fully unit-tested: write-through, near-hit short-circuit, slow-hit backfill, tag/prefix invalidation across layers.

### Patch Changes

- @basaltkit/cache@0.23.0
