/** A message delivered to a client on a channel. */
export interface RealtimeMessage {
  channel: string
  event: string
  data: unknown
}

/** The same message tagged with its tenant — what travels over the backplane. */
export interface BackplaneMessage extends RealtimeMessage {
  tenantId: string
}

/**
 * A live client. Transports (WebSocket, SSE) build one of these from their
 * native socket/response — the hub only ever calls `send`/`close`, so the core
 * stays framework-neutral and unit-testable with fakes.
 */
export interface Connection {
  readonly id: string
  readonly tenantId: string
  readonly userId?: string | undefined
  send(message: RealtimeMessage): void
  close(): void
}

/**
 * Fans messages out across instances. In a single process the in-memory
 * backplane loops straight back; with Redis, publish → PUBLISH and every
 * instance (including this one) receives it via SUBSCRIBE, so delivery is
 * uniform whether you run one node or many.
 */
export interface RealtimeBackplane {
  publish(message: BackplaneMessage): Promise<void>
  subscribe(handler: (message: BackplaneMessage) => void): Promise<void>
  close?(): Promise<void>
}

/** Single-process backplane: publish invokes the subscriber synchronously. */
export class MemoryBackplane implements RealtimeBackplane {
  private handler: ((message: BackplaneMessage) => void) | undefined
  async publish(message: BackplaneMessage): Promise<void> {
    this.handler?.(message)
  }
  async subscribe(handler: (message: BackplaneMessage) => void): Promise<void> {
    this.handler = handler
  }
}

/**
 * Map key for a (tenant, channel) pair. Injective by construction: JSON
 * encoding escapes every character a delimiter could be smuggled through, so
 * no tenant id can be chosen to alias another tenant's channel (a plain
 * separator — even NUL — collides when either part contains it).
 */
const key = (tenantId: string, channel: string): string => JSON.stringify([tenantId, channel])

export interface RealtimeHubOptions {
  /**
   * Server-side subscription gate. Return `false` (or reject) to refuse a
   * client's request to join `channel`. **Set this whenever a channel carries
   * anything not readable by every member of the tenant** (a user's private
   * channel, an admin channel): without it, any authenticated connection can
   * subscribe to any channel name within its tenant. Default: allow all.
   */
  authorize?: (connection: Connection, channel: string) => boolean | Promise<boolean>
  /** Max distinct channels one connection may hold (DoS bound). Default 1000. */
  maxSubscriptionsPerConnection?: number
  /** Max channel-name length (DoS bound). Default 256. */
  maxChannelLength?: number
  /**
   * A local delivery failed — the connection's `send` threw (dead/closing
   * socket). The connection is pruned and closed, and the remaining recipients
   * still get the message; the failure lands here. Default: console.error with context.
   * (Same pattern as the plugin's `onBridgeError`.)
   */
  onDeliveryError?: (
    error: unknown,
    info: { connectionId: string; tenantId: string; channel: string; event: string },
  ) => void
}

/**
 * The neutral core: tracks connections, their channel subscriptions and
 * presence, and delivers messages. All I/O (sockets, Redis) is behind the
 * {@link Connection} and {@link RealtimeBackplane} seams.
 */
export class RealtimeHub {
  private readonly connections = new Map<string, Connection>()
  private readonly channels = new Map<string, Set<string>>() // channelKey → connIds
  private readonly subscriptions = new Map<string, Set<string>>() // connId → channels
  private readonly presenceMap = new Map<string, Map<string, string>>() // channelKey → connId → userId

  constructor(
    private readonly backplane: RealtimeBackplane = new MemoryBackplane(),
    private readonly options: RealtimeHubOptions = {},
  ) {}

  /** Wire the backplane so cross-instance messages reach local connections. */
  async start(): Promise<void> {
    await this.backplane.subscribe((message) => this.deliverLocal(message))
  }

  register(connection: Connection): void {
    // A DIFFERENT connection reusing a live id (an app that lets the client
    // pick or echo its connection id) must start clean. Otherwise it would
    // inherit the old connection's subscriptions, which are keyed by the OLD
    // tenant, and receive that tenant's channels. Detach them first, under the
    // old connection's tenant. Re-registering the same object stays idempotent.
    const previous = this.connections.get(connection.id)
    if (previous !== undefined && previous !== connection) this.unregister(connection.id)
    this.connections.set(connection.id, connection)
    if (!this.subscriptions.has(connection.id)) this.subscriptions.set(connection.id, new Set())
  }

  unregister(connectionId: string): void {
    for (const channel of this.subscriptions.get(connectionId) ?? []) {
      this.detach(connectionId, channel)
    }
    this.subscriptions.delete(connectionId)
    this.connections.delete(connectionId)
  }

  /**
   * Attaches a connection to a channel. Returns whether the subscription was
   * accepted — `false` when the connection is unknown (or was unregistered or
   * replaced while `authorize` was pending), the channel is not a string or is
   * empty/too long, the per-connection cap is reached, or the `authorize` gate
   * refused it. Adapters SHOULD check the result and signal/close on refusal.
   */
  async subscribe(connectionId: string, channel: string): Promise<boolean> {
    // Channel names usually come straight from a client command (`JSON.parse`
    // of a socket frame), so the type is not guaranteed: an array or object
    // would slip past the length check and be keyed by identity.
    if (typeof channel !== 'string') return false
    const connection = this.connections.get(connectionId)
    if (!connection) return false
    if (this.subscriptions.get(connectionId)!.has(channel)) return true // idempotent

    const maxLen = this.options.maxChannelLength ?? 256
    if (channel.length === 0 || channel.length > maxLen) return false
    const cap = this.options.maxSubscriptionsPerConnection ?? 1000
    if (this.subscriptions.get(connectionId)!.size >= cap) return false
    // Server-side authorization: refuse a channel this connection may not join.
    if (this.options.authorize && !(await this.options.authorize(connection, channel))) return false

    // Re-check after the await (FA-065): while the gate was deciding, the
    // connection may have closed (unregister) or been replaced by another
    // connection reusing its id — attaching now would leave a ghost entry, or
    // hand the replacement a channel authorized for someone else. Concurrent
    // subscribes also all passed the cap check above before any of them
    // attached, so the cap is enforced again here.
    if (this.connections.get(connectionId) !== connection) return false
    const subs = this.subscriptions.get(connectionId)
    if (!subs) return false
    if (subs.has(channel)) return true
    if (subs.size >= cap) return false

    subs.add(channel)
    const k = key(connection.tenantId, channel)
    ;(this.channels.get(k) ?? this.channels.set(k, new Set()).get(k)!).add(connectionId)
    if (connection.userId !== undefined) {
      ;(this.presenceMap.get(k) ?? this.presenceMap.set(k, new Map()).get(k)!).set(connectionId, connection.userId)
    }
    return true
  }

  unsubscribe(connectionId: string, channel: string): void {
    this.subscriptions.get(connectionId)?.delete(channel)
    this.detach(connectionId, channel)
  }

  /** Publishes to every subscriber of (tenant, channel), across all instances. */
  async publish(tenantId: string, channel: string, event: string, data: unknown): Promise<void> {
    // Fail the emit, not the recipients (FA-065): a payload JSON can't encode
    // (BigInt, a cycle) would otherwise throw inside every connection's `send`
    // and get each of them pruned as "dead". Rejecting here also matches the
    // Redis backplane, which has always rejected at `JSON.stringify`.
    JSON.stringify(data)
    await this.backplane.publish({ tenantId, channel, event, data })
  }

  /** The distinct user ids currently subscribed to (tenant, channel) on this node. */
  presence(tenantId: string, channel: string): string[] {
    const users = this.presenceMap.get(key(tenantId, channel))
    return users ? [...new Set(users.values())] : []
  }

  /** Live connection count for (tenant, channel) on this node. */
  count(tenantId: string, channel: string): number {
    return this.channels.get(key(tenantId, channel))?.size ?? 0
  }

  private detach(connectionId: string, channel: string): void {
    const connection = this.connections.get(connectionId)
    if (!connection) return
    const k = key(connection.tenantId, channel)
    const set = this.channels.get(k)
    set?.delete(connectionId)
    if (set && set.size === 0) this.channels.delete(k)
    const presence = this.presenceMap.get(k)
    presence?.delete(connectionId)
    if (presence && presence.size === 0) this.presenceMap.delete(k)
  }

  private deliverLocal(message: BackplaneMessage): void {
    const ids = this.channels.get(key(message.tenantId, message.channel))
    if (!ids) return
    const payload: RealtimeMessage = { channel: message.channel, event: message.event, data: message.data }
    // Per-recipient isolation (Q-3): one dead socket must neither stop the
    // remaining recipients nor throw into the backplane's message emitter
    // (fatal on a real ioredis subscriber). A throwing send means the
    // connection is gone — prune it, report it, keep delivering.
    const dead: string[] = []
    for (const id of [...ids]) {
      try {
        this.connections.get(id)?.send(payload)
      } catch (error) {
        dead.push(id)
        const report =
          this.options.onDeliveryError ??
          ((err: unknown, info: { connectionId: string; tenantId: string; channel: string; event: string }) =>
            console.error(
              `[basalt:realtime] delivery to connection "${info.connectionId}" failed (tenant "${info.tenantId}", channel "${info.channel}", event "${info.event}") — pruning:`,
              err,
            ))
        report(error, { connectionId: id, tenantId: message.tenantId, channel: message.channel, event: message.event })
      }
    }
    for (const id of dead) {
      const connection = this.connections.get(id)
      this.unregister(id)
      // Close what was pruned: a socket that is merely unregistered stays open,
      // so the client believes it is subscribed, never reconnects, and never
      // hears anything again.
      try {
        connection?.close()
      } catch {
        // already gone — nothing left to release
      }
    }
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) connection.close()
    this.connections.clear()
    await this.backplane.close?.()
  }
}
