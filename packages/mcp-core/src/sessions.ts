import { randomBytes } from 'node:crypto'

/** Idle lifetime of an MCP HTTP session by default: 30 minutes since its last request. */
export const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000

/** Live MCP HTTP sessions kept at once by default. */
export const DEFAULT_MAX_SESSIONS = 1000

/** The HTTP header carrying the session id (Streamable HTTP transport). */
export const MCP_SESSION_HEADER = 'mcp-session-id'

export interface McpSessionOptions {
  /**
   * Idle lifetime: a session unused for this long is gone, and a request
   * naming it is answered 404 (the client re-initializes). Default
   * {@link DEFAULT_SESSION_TTL_MS}.
   */
  ttlMs?: number
  /**
   * Most live sessions kept at once. At the cap, expired sessions are purged
   * first, then the least recently used one is evicted — its client gets a 404
   * on its next request and re-initializes, rather than a flood of
   * `initialize` calls locking every new client out. Default
   * {@link DEFAULT_MAX_SESSIONS}.
   */
  maxSessions?: number
}

/**
 * One MCP session. The object itself is the session identity the core server
 * scopes in-flight calls (and `notifications/cancelled`) by — pass it as
 * `CallContext.session` for every request of the session.
 */
export interface McpSession {
  readonly id: string
  /** Who opened it — a request must present the same principal to use it. */
  readonly principal: string
  /** Last time a request used it (ms since epoch). */
  lastSeen: number
}

/**
 * The session table of the Streamable HTTP transport: ids issued on
 * `initialize`, required on every later request, each bound to the principal
 * that opened it, expiring when idle and capped in number.
 *
 * Binding is what makes the id safe to accept: a request whose principal
 * differs from the session's is treated exactly like one naming an unknown
 * session (so the id of someone else's session reveals nothing and cancels
 * nothing). In-memory and per process — behind several replicas, route a
 * session's requests to one replica (sticky sessions) or run stateless.
 */
export class McpSessions {
  private readonly sessions = new Map<string, McpSession>()
  private readonly ttlMs: number
  private readonly maxSessions: number

  constructor(options: McpSessionOptions = {}, private readonly now: () => number = Date.now) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS)
  }

  /** Live sessions (expired ones may still be counted until the next purge). */
  get size(): number {
    return this.sessions.size
  }

  /** Open a session for `principal` and return it (its `id` goes in the response header). */
  create(principal: string): McpSession {
    if (this.sessions.size >= this.maxSessions) this.purgeExpired()
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    // 192 random bits, base64url: visible ASCII, as the spec requires.
    const session: McpSession = { id: randomBytes(24).toString('base64url'), principal, lastSeen: this.now() }
    this.sessions.set(session.id, session)
    return session
  }

  /**
   * The live session `id` names, provided `principal` opened it — refreshing
   * its idle timer. `undefined` for an unknown, expired or foreign session.
   */
  resolve(id: string | undefined, principal: string): McpSession | undefined {
    if (id === undefined) return undefined
    const session = this.sessions.get(id)
    if (!session || session.principal !== principal) return undefined
    const now = this.now()
    if (now - session.lastSeen > this.ttlMs) {
      this.sessions.delete(id)
      return undefined
    }
    session.lastSeen = now
    // Re-insert: Map order is the LRU order eviction walks.
    this.sessions.delete(id)
    this.sessions.set(id, session)
    return session
  }

  /** End a session (HTTP `DELETE`). False when `principal` has no such live session. */
  delete(id: string | undefined, principal: string): boolean {
    const session = this.resolve(id, principal)
    if (!session) return false
    this.sessions.delete(session.id)
    return true
  }

  private purgeExpired(): void {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > this.ttlMs) this.sessions.delete(id)
    }
  }
}

/** True when a decoded payload is a single (unbatched) `initialize` request. */
export function isInitializeRequest(payload: unknown): boolean {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    (payload as { method?: unknown }).method === 'initialize' &&
    (payload as { id?: unknown }).id !== undefined
  )
}
