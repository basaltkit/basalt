export interface TenantClientPoolOptions<TClient> {
  /** Creates the client for a tenant (e.g. new PrismaClient({ datasourceUrl })). */
  create(tenantId: string): TClient | Promise<TClient>
  /** Called when a client is evicted (e.g. client.$disconnect()). */
  destroy?(client: TClient, tenantId: string): void | Promise<void>
  /** Maximum simultaneously open clients. Default: 10 */
  max?: number
}

/**
 * LRU pool of per-tenant clients — the piece that makes database-per-tenant
 * viable: each tenant gets its own client, and idle ones are evicted so
 * connection counts stay bounded.
 */
export class TenantClientPool<TClient> {
  /** Map preserves insertion order — re-inserting on access gives us LRU. */
  private readonly clients = new Map<string, TClient>()
  private readonly max: number

  constructor(private readonly options: TenantClientPoolOptions<TClient>) {
    this.max = Math.max(1, options.max ?? 10)
  }

  async get(tenantId: string): Promise<TClient> {
    const existing = this.clients.get(tenantId)
    if (existing !== undefined) {
      // bump to most-recently-used
      this.clients.delete(tenantId)
      this.clients.set(tenantId, existing)
      return existing
    }

    const client = await this.options.create(tenantId)
    this.clients.set(tenantId, client)

    while (this.clients.size > this.max) {
      const [oldestId, oldest] = this.clients.entries().next().value as [string, TClient]
      this.clients.delete(oldestId)
      await this.options.destroy?.(oldest, oldestId)
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
    const entries = [...this.clients.entries()]
    this.clients.clear()
    for (const [tenantId, client] of entries) {
      await this.options.destroy?.(client, tenantId)
    }
  }
}
