import { createHash } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'

/** Raised when an identifier has exceeded the failed-login budget. */
export class AccountLockedError extends BasaltError {
  readonly status = 429
  constructor(readonly retryAfterMs: number) {
    super(
      'AUTH_LOCKED',
      `Too many failed login attempts. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`,
    )
  }
}

export interface LoginThrottleOptions {
  /** Failed attempts allowed within the window. Default 5. */
  maxAttempts?: number
  /** Rolling window in ms. Default 15 minutes. */
  windowMs?: number
  /**
   * Upper bound on tracked identifiers. When full, expired entries are swept
   * and then the oldest ones are evicted, so failed logins with unique
   * identifiers cannot grow the heap without limit. Default 100 000.
   */
  maxEntries?: number
  /** Injectable clock for tests. */
  clock?: () => number
}

interface Entry {
  count: number
  resetAt: number
}

/**
 * Brute-force guard: counts failed logins per identifier (email) within a
 * rolling window and locks the account once the budget is spent. A successful
 * login clears the counter. In-memory per process; back it with Redis for a
 * cluster by supplying the same behavior.
 *
 * Identifiers are stored as SHA-256 digests (fixed size, never the raw email),
 * and the table is bounded by {@link LoginThrottleOptions.maxEntries}.
 *
 * Use {@link reserve} before verifying credentials: it counts the attempt
 * synchronously, so a parallel burst cannot run more verifications than the
 * budget allows. {@link release} gives the reservation back on success.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, Entry>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly maxEntries: number
  private readonly clock: () => number

  constructor(options: LoginThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.windowMs = options.windowMs ?? 15 * 60_000
    this.maxEntries = Math.max(1, options.maxEntries ?? 100_000)
    this.clock = options.clock ?? (() => Date.now())
  }

  /** Number of identifiers currently tracked. */
  get size(): number {
    return this.failures.size
  }

  /** Total characters retained in keys — diagnostics for memory bounds. */
  retainedKeyChars(): number {
    let n = 0
    for (const key of this.failures.keys()) n += key.length
    return n
  }

  private digest(key: string): string {
    return createHash('sha256').update(key).digest('base64url')
  }

  private live(digest: string, now: number): Entry | undefined {
    const entry = this.failures.get(digest)
    if (entry && now >= entry.resetAt) {
      this.failures.delete(digest)
      return undefined
    }
    return entry
  }

  private store(digest: string, entry: Entry, now: number): void {
    if (!this.failures.has(digest) && this.failures.size >= this.maxEntries) {
      for (const [k, e] of this.failures) if (now >= e.resetAt) this.failures.delete(k)
      // Still full: evict the oldest entries (Map iterates in insertion order).
      for (const k of this.failures.keys()) {
        if (this.failures.size < this.maxEntries) break
        this.failures.delete(k)
      }
    }
    this.failures.set(digest, entry)
  }

  /** Throws {@link AccountLockedError} when the key is currently locked. */
  assertAllowed(key: string): void {
    const now = this.clock()
    const entry = this.live(this.digest(key), now)
    if (entry && entry.count >= this.maxAttempts) {
      throw new AccountLockedError(entry.resetAt - now)
    }
  }

  recordFailure(key: string): void {
    const now = this.clock()
    const digest = this.digest(key)
    const entry = this.live(digest, now) ?? { count: 0, resetAt: now + this.windowMs }
    entry.count += 1
    this.store(digest, entry, now)
  }

  /**
   * Atomically checks the budget and counts this attempt (synchronously, before
   * any await), throwing {@link AccountLockedError} when it is spent. Pair with
   * {@link release} on success; a failure simply keeps the reservation.
   */
  reserve(key: string): void {
    const now = this.clock()
    const digest = this.digest(key)
    const entry = this.live(digest, now)
    if (entry && entry.count >= this.maxAttempts) throw new AccountLockedError(entry.resetAt - now)
    const next = entry ?? { count: 0, resetAt: now + this.windowMs }
    next.count += 1
    this.store(digest, next, now)
  }

  /** Returns one reservation (a successful attempt must not consume budget). */
  release(key: string): void {
    const digest = this.digest(key)
    const entry = this.live(digest, this.clock())
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) this.failures.delete(digest)
  }

  reset(key: string): void {
    this.failures.delete(this.digest(key))
  }
}
