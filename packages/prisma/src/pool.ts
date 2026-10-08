import { BasaltError } from '@basaltkit/core'

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
  /**
   * How long a client handed out by `get()` still counts as in use after the
   * call, in milliseconds. `get()` cannot know when its caller is done (an
   * HTTP request, a job), so the pool treats the client as busy for this long
   * and never evicts — or disconnects — it in that window. Clients held
   * through `acquire()`/`use()` are tracked exactly instead, and are never
   * evicted while leased, whatever this says. Default: 30_000.
   */
  idleMs?: number
  /**
   * How long `get()`/`acquire()` wait for a free slot when every open client
   * is in use, before failing with `TenantPoolExhaustedError` (503). The pool
   * never opens more than `max` clients to serve a new tenant. Default: 10_000.
   */
  acquireTimeoutMs?: number
}

/** A client held by `acquire()`: it cannot be evicted until `release()`. */
export interface TenantClientLease<TClient> {
  readonly client: TClient
  /** Returns the client to the pool. Idempotent. */
  release(): void
}

/**
 * Thrown when a tenant needs a client, the pool already holds `max` clients,
 * and none of them could be evicted (all leased or used within `idleMs`)
 * before `acquireTimeoutMs` ran out. The alternative — opening one more, or
 * disconnecting a client someone is still using — is exactly what the cap
 * exists to prevent. Raise `max` to at least the number of tenants that are
 * active at the same time.
 */
export class TenantPoolExhaustedError extends BasaltError {
  readonly status = 503
  /**
   * @param usage How the `max` slots were held when the wait gave up:
   *   `leased` clients have an open `acquire()` lease (a request or job is
   *   using them right now); `recentlyUsed` ones were only handed out by
   *   `get()` or released less than `idleMs` ago.
   */
  constructor(
    tenantId: string,
    max: number,
    waitedMs: number,
    usage: { leased: number; recentlyUsed: number } = { leased: 0, recentlyUsed: 0 },
  ) {
    const { leased, recentlyUsed } = usage
    // Leases dominate → that many tenants are genuinely active at once, and
    // only more slots help. Otherwise the slots are held by the idle grace
    // window, and a shorter `idleMs` frees them.
    const advice =
      leased >= recentlyUsed
        ? 'Raise `max` to at least the number of tenants active at the same time, or release leases sooner.'
        : 'Lower `idleMs` (clients stay reserved that long after use) or raise `max`.'
    super(
      'PRISMA_POOL_EXHAUSTED',
      `No database client slot for tenant "${tenantId}": all ${max} pooled clients stayed in use ` +
        `for ${waitedMs}ms (${leased} leased, ${recentlyUsed} recently used). ${advice}`,
      { details: { tenantId, max, leased, recentlyUsed } },
    )
  }
}

const disconnectIfPossible = async (client: unknown): Promise<void> => {
  const disconnect = (client as { $disconnect?: unknown } | null)?.$disconnect
  if (typeof disconnect === 'function') await (disconnect as () => unknown).call(client)
}

interface Entry<TClient> {
  readonly client: TClient
  /** Open `acquire()` leases. */
  leases: number
  /** Last hand-out or release, epoch ms. */
  lastUsed: number
}

interface Creation<TClient> {
  promise: Promise<Entry<TClient>>
  /** Callers awaiting this creation; each holds a pin on the new client. */
  waiters: number
}

/**
 * Bounded pool of per-tenant clients — the piece that makes database-per-tenant
 * viable: each tenant gets its own client, and idle ones are evicted
 * (least-recently-used first) so connection counts stay bounded.
 *
 * Only IDLE clients are evicted: a client with an open lease, or handed out by
 * `get()` less than `idleMs` ago, is in use, and disconnecting it would break
 * its in-flight queries and let it silently reconnect outside the pool. When
 * the pool is full of in-use clients a new tenant waits for one to become
 * idle, then fails with `TenantPoolExhaustedError` — the cap is never
 * exceeded, and never enforced by pulling a client from under its user.
 *
 * Concurrent first use of a tenant shares ONE in-flight creation, so a burst
 * of requests at a cold tenant cannot open (and leak) duplicate clients.
 */
export class TenantClientPool<TClient> {
  /** Map preserves insertion order — re-inserting on access gives us LRU. */
  private readonly clients = new Map<string, Entry<TClient>>()
  /** Creations in flight, so concurrent callers await the same client. */
  private readonly pending = new Map<string, Creation<TClient>>()
  /** Slots reserved by creations in flight (they count against `max`). */
  private creating = 0
  /** Callers waiting for a slot; woken whenever one may have freed up. */
  private readonly waiters = new Set<() => void>()
  private readonly max: number
  private readonly idleMs: number
  private readonly acquireTimeoutMs: number
  private readonly destroyClient: (client: TClient, tenantId: string) => void | Promise<void>
  /** Bumped by destroyAll(): a creation that started before it is discarded. */
  private generation = 0

  constructor(private readonly options: TenantClientPoolOptions<TClient>) {
    this.max = Math.max(1, options.max ?? 10)
    this.idleMs = Math.max(0, options.idleMs ?? 30_000)
    this.acquireTimeoutMs = Math.max(0, options.acquireTimeoutMs ?? 10_000)
    this.destroyClient = options.destroy
      ? (client, tenantId) => options.destroy!(client, tenantId)
      : (client) => disconnectIfPossible(client)
  }

  /**
   * The tenant's client. It counts as in use for `idleMs` after this call —
   * for work that may outlast that, hold it with {@link acquire} or
   * {@link use} instead.
   */
  async get(tenantId: string): Promise<TClient> {
    return this.checkout(tenantId, false)
  }

  /**
   * The tenant's client, leased: it is never evicted until `release()` is
   * called. Always release (a `finally`), or prefer {@link use}.
   */
  async acquire(tenantId: string): Promise<TenantClientLease<TClient>> {
    const client = await this.checkout(tenantId, true)
    const entry = this.clients.get(tenantId)
    let released = false
    return {
      client,
      release: () => {
        if (released) return
        released = true
        // The entry may be gone (destroyAll); then there is nothing to return.
        if (entry && this.clients.get(tenantId) === entry) {
          entry.leases = Math.max(0, entry.leases - 1)
          entry.lastUsed = Date.now()
        }
        this.wake()
      },
    }
  }

  /** Runs `fn` with the tenant's client leased for exactly its duration. */
  async use<T>(tenantId: string, fn: (client: TClient) => T | Promise<T>): Promise<T> {
    const lease = await this.acquire(tenantId)
    try {
      return await fn(lease.client)
    } finally {
      lease.release()
    }
  }

  private async checkout(tenantId: string, lease: boolean): Promise<TClient> {
    const generation = this.generation
    const existing = this.clients.get(tenantId)
    if (existing !== undefined) {
      // bump to most-recently-used, and mark it in use — synchronously, so
      // nothing can evict it between the lookup and the hand-out
      this.touch(tenantId, existing)
      if (lease) existing.leases++
      return existing.client
    }

    const creation = this.pending.get(tenantId) ?? this.startCreation(tenantId)
    // Every caller waiting on the creation pins the new client (as a lease)
    // from the moment it enters the pool until that caller resumes, so a full
    // pool cannot evict it before anyone got to use it.
    creation.waiters++
    const entry = await creation.promise
    if (generation !== this.generation || this.clients.get(tenantId) !== entry) {
      return entry.client // shut down meanwhile: the client was destroyed, as before
    }
    this.touch(tenantId, entry)
    if (!lease) {
      entry.leases--
      this.wake()
    }
    return entry.client
  }

  private touch(tenantId: string, entry: Entry<TClient>): void {
    this.clients.delete(tenantId)
    this.clients.set(tenantId, entry)
    entry.lastUsed = Date.now()
  }

  private startCreation(tenantId: string): Creation<TClient> {
    const creation: Creation<TClient> = {
      waiters: 0,
      promise: undefined as unknown as Promise<Entry<TClient>>,
    }
    creation.promise = this.create(tenantId, creation, Date.now() + this.acquireTimeoutMs)
    this.pending.set(tenantId, creation)
    return creation
  }

  private async create(
    tenantId: string,
    creation: Creation<TClient>,
    deadline: number,
  ): Promise<Entry<TClient>> {
    const generation = this.generation
    const settle = (): void => {
      // settled (resolved or rejected): a failure is not cached
      if (this.pending.get(tenantId) === creation) this.pending.delete(tenantId)
    }
    let client: TClient
    try {
      await this.reserveSlot(tenantId, deadline)
      try {
        client = await this.options.create(tenantId)
      } finally {
        this.creating--
        this.wake()
      }
    } catch (error) {
      settle()
      throw error
    }
    settle()
    const entry: Entry<TClient> = { client, leases: creation.waiters, lastUsed: Date.now() }
    if (generation !== this.generation) {
      // destroyAll() ran meanwhile (shutdown): do not keep a live client
      await this.destroyClient(client, tenantId)
      return entry
    }
    this.clients.set(tenantId, entry)
    return entry
  }

  /** Takes one slot for a creation: a free one, an idle client's, or waits. */
  private async reserveSlot(tenantId: string, deadline: number): Promise<void> {
    const started = Date.now()
    for (;;) {
      if (this.clients.size + this.creating < this.max) {
        this.creating++
        return
      }
      const victim = this.idleVictim()
      if (victim) {
        const [victimId, entry] = victim
        this.clients.delete(victimId)
        this.creating++ // the freed slot is ours while the victim disconnects
        try {
          await this.destroyClient(entry.client, victimId)
        } catch (error) {
          this.creating--
          this.wake()
          throw error
        }
        return
      }
      if (Date.now() >= deadline) {
        throw new TenantPoolExhaustedError(tenantId, this.max, Date.now() - started, this.usage())
      }
      await this.waitForSlot(deadline)
    }
  }

  /** Open clients by why they cannot be evicted right now. */
  private usage(): { leased: number; recentlyUsed: number } {
    const now = Date.now()
    let leased = 0
    let recentlyUsed = 0
    for (const entry of this.clients.values()) {
      if (entry.leases > 0) leased++
      else if (now - entry.lastUsed < this.idleMs) recentlyUsed++
    }
    return { leased, recentlyUsed }
  }

  /** Least-recently-used client that is neither leased nor within `idleMs`. */
  private idleVictim(): [string, Entry<TClient>] | undefined {
    const now = Date.now()
    for (const pair of this.clients) {
      const entry = pair[1]
      if (entry.leases === 0 && now - entry.lastUsed >= this.idleMs) return pair
    }
    return undefined
  }

  /** Resolves on the next wake(), when a client may turn idle, or at the deadline. */
  private waitForSlot(deadline: number): Promise<void> {
    let wakeAt = deadline
    for (const entry of this.clients.values()) {
      if (entry.leases === 0) wakeAt = Math.min(wakeAt, entry.lastUsed + this.idleMs)
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, wakeAt - Date.now()))
      ;(timer as { unref?: () => void }).unref?.()
      this.waiters.add(done)
    })
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  has(tenantId: string): boolean {
    return this.clients.has(tenantId)
  }

  /** Open clients held by the pool (never more than `max`). */
  get size(): number {
    return this.clients.size
  }

  async destroyAll(): Promise<void> {
    this.generation++
    this.pending.clear()
    const entries = [...this.clients.entries()]
    this.clients.clear()
    this.wake()
    for (const [tenantId, entry] of entries) {
      await this.destroyClient(entry.client, tenantId)
    }
  }
}
