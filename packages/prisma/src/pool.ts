export interface TenantClientPoolOptions<TClient> {
  /** Creates the client for a tenant (e.g. new PrismaClient({ datasourceUrl })). */
  create(tenantId: string): TClient | Promise<TClient>
  /**
   * Called when a client is evicted or on destroyAll(). Default: calls
   * `client.$disconnect()` when the client has one, so evicted clients never
   * keep their connections open.
   */
  destroy?(client: TClient, tenantId: string): void | Promise<void>
  /** Maximum simultaneously open clients. Default: 10 */
  max?: number
}

const disconnectIfPossible = async (client: unknown): Promise<void> => {
  const disconnect = (client as { $disconnect?: unknown } | null)?.$disconnect
  if (typeof disconnect === 'function') await (disconnect as () => unknown).call(client)
}

/**
 * LRU pool of per-tenant clients — the piece that makes database-per-tenant
 * viable: each tenant gets its own client, and idle ones are evicted so
 * connection counts stay bounded.
 *
 * Concurrent first use of a tenant shares ONE in-flight creation, so a burst
 * of requests at a cold tenant cannot open (and leak) duplicate clients.
 */
export class TenantClientPool<TClient> {
  /** Map preserves insertion order — re-inserting on access gives us LRU. */
  private readonly clients = new Map<string, TClient>()
  /** Creations in flight, so concurrent callers await the same client. */
  private readonly pending = new Map<string, { readonly promise: Promise<TClient> }>()
  private readonly max: number
  private readonly destroyClient: (client: TClient, tenantId: string) => void | Promise<void>
  /** Bumped by destroyAll(): a creation that started before it is discarded. */
  private generation = 0

  constructor(private readonly options: TenantClientPoolOptions<TClient>) {
    this.max = Math.max(1, options.max ?? 10)
    this.destroyClient = options.destroy
      ? (client, tenantId) => options.destroy!(client, tenantId)
      : (client) => disconnectIfPossible(client)
  }

  async get(tenantId: string): Promise<TClient> {
    const existing = this.clients.get(tenantId)
    if (existing !== undefined) {
      // bump to most-recently-used
      this.clients.delete(tenantId)
      this.clients.set(tenantId, existing)
      return existing
    }

    const inFlight = this.pending.get(tenantId)
    if (inFlight) return inFlight.promise

    const entry = { promise: this.create(tenantId) }
    this.pending.set(tenantId, entry)
    try {
      return await entry.promise
    } finally {
      // settled (resolved or rejected): a failure is not cached
      if (this.pending.get(tenantId) === entry) this.pending.delete(tenantId)
    }
  }

  private async create(tenantId: string): Promise<TClient> {
    const generation = this.generation
    const client = await this.options.create(tenantId)
    if (generation !== this.generation) {
      // destroyAll() ran meanwhile (shutdown): do not keep a live client
      await this.destroyClient(client, tenantId)
      return client
    }
    this.clients.set(tenantId, client)

    while (this.clients.size > this.max) {
      const [oldestId, oldest] = this.clients.entries().next().value as [string, TClient]
      this.clients.delete(oldestId)
      await this.destroyClient(oldest, oldestId)
    }
    return client
  }

  has(tenantId: string): boolean {
    return this.clients.has(tenantId)
  }

  get size(): number {
    return this.clients.size
  }

  async destroyAll(): Promise<void> {
    this.generation++
    this.pending.clear()
    const entries = [...this.clients.entries()]
    this.clients.clear()
    for (const [tenantId, client] of entries) {
      await this.destroyClient(client, tenantId)
    }
  }
}
