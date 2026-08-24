---
'@basaltkit/prisma': minor
---

Horizontal sharding: `ShardRouter` maps a key (typically a tenant id) to one of
a fixed set of database clients with a deterministic FNV-1a hash — a tenant's
data always lives on the same shard. Wire it with `prismaPlugin({ shards })`,
which routes each request/tenancy switch to its shard client (long-lived, shared
by many tenants — no eviction) and disconnects every shard on shutdown. Also
adds a low-level `resolveClient` escape hatch and `router.all()` for cross-shard
migrations and fan-out reads.
