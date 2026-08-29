---
"@basaltkit/cache-tiered": minor
---

**Advisory — `backfillTtlMs` is now a real cross-replica staleness bound: direct writes to the near layers are clamped to it.**

`set()` used to write the entry's **full TTL** into every layer, including the in-process near cache. With multiple replicas (no invalidation bus exists), a replica that wrote a key kept serving its local copy for the entire TTL — hours — after another replica updated or deleted it, far beyond the documented near-cache bound. Now every layer **except the last (shared) one** is clamped to `backfillTtlMs` (default 60 s), the same bound already applied to read backfills; the far cache keeps the caller's TTL and remains the source of truth.

- Verified by a two-replica test: after replica A updates a key, replica B serves the new value within `backfillTtlMs` even for keys B wrote itself.
- **Trade-off:** hot keys re-read the far cache once per bound per replica (one extra Redis GET/min by default) in exchange for bounded staleness.
- `backfillTtlMs: null` still opts out entirely (single-replica deployments) — that now disables the coherence bound too, and is documented as such.

A pub/sub invalidation bus (near-instant coherence) was considered and deliberately not built: the bound already expresses the tier contract, and a bus adds a subscriber lifecycle + a new driver contract for an edge the bound covers. It remains a possible future opt-in.
