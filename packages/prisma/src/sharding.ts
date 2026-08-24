/**
 * Horizontal sharding: route a key (typically a tenant id) to one of a fixed
 * set of database clients. The mapping is deterministic — the same key always
 * lands on the same shard across processes and restarts — so a tenant's data
 * always lives on the same database.
 *
 * Unlike the per-tenant pool, shard clients are long-lived and shared by many
 * tenants; nothing is evicted. Wire it with `prismaPlugin({ shards })`.
 */

export type ShardHash = (key: string, shardCount: number) => number

/**
 * FNV-1a → shard index. A fast, stable, non-cryptographic hash: the same key
 * yields the same shard on every machine. (Add/removing shards re-maps keys —
 * plan migrations before changing `shards.length`.)
 */
export const fnv1aShard: ShardHash = (key, shardCount) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % shardCount
}

export interface ShardRouterOptions<TClient> {
  /** The shard clients, in a stable order (index = shard number). */
  shards: TClient[]
  /** Key → shard index. Default: FNV-1a. */
  hash?: ShardHash
}

export class ShardRouter<TClient> {
  private readonly shards: TClient[]
  private readonly hash: ShardHash

  constructor(options: ShardRouterOptions<TClient>) {
    if (options.shards.length === 0) {
      throw new Error('ShardRouter needs at least one shard.')
    }
    this.shards = [...options.shards] // defensive copy: later caller mutation must not remap live tenants
    this.hash = options.hash ?? fnv1aShard
  }

  /** Number of shards. */
  get count(): number {
    return this.shards.length
  }

  /** The shard index a key maps to (deterministic). */
  indexOf(key: string): number {
    return this.hash(key, this.shards.length)
  }

  /** The client a key routes to. */
  for(key: string): TClient {
    return this.shards[this.indexOf(key)]!
  }

  /** Every shard client — for cross-shard migrations and fan-out reads. */
  all(): TClient[] {
    return [...this.shards]
  }
}
