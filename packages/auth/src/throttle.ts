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

/** A throttle counter's state within its current window. */
export interface ThrottleWindow {
  /** Attempts counted in the current window. */
  count: number
  /** Milliseconds until the window closes and the counter starts over. */
  retryAfterMs: number
}

/**
 * Where throttle counters live. The default {@link MemoryThrottleStore} is per
 * process; pass a shared one ({@link RedisThrottleStore}) so every replica of a
 * cluster spends ONE budget — otherwise an attacker gets `maxAttempts` guesses
 * per replica, and a lockout on one replica is not seen by the others.
 *
 * Methods may be sync or async: an in-process store stays synchronous (so the
 * count moves before any await), a network store returns promises. `hit` MUST
 * be atomic — increment and read in one step — since it is what bounds a
 * parallel burst. Keys arrive already digested (never a raw email).
 */
export interface ThrottleStore {
  /**
   * Atomically counts one attempt and returns the new state. The first hit of
   * a key opens a fixed window of `windowMs`; later hits do not extend it.
   */
  hit(key: string, windowMs: number): ThrottleWindow | Promise<ThrottleWindow>
  /** The current state without counting; null when the key has no live window. */
  peek(key: string): ThrottleWindow | null | Promise<ThrottleWindow | null>
  /** Gives one attempt back (a successful attempt must not consume budget). */
  release(key: string): void | Promise<void>
  /** Forgets the key. */
  reset(key: string): void | Promise<void>
}

export interface MemoryThrottleStoreOptions {
  /**
   * Upper bound on tracked keys. When full, expired entries are swept and then
   * the oldest ones are evicted, so failed logins with unique identifiers
   * cannot grow the heap without limit. Default 100 000.
   */
  maxEntries?: number
  /** Injectable clock for tests. */
  clock?: () => number
}

interface Entry {
  count: number
  resetAt: number
}

/** In-process {@link ThrottleStore} (the default): synchronous and bounded. */
export class MemoryThrottleStore implements ThrottleStore {
  private readonly entries = new Map<string, Entry>()
  private readonly maxEntries: number
  private readonly clock: () => number

  constructor(options: MemoryThrottleStoreOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 100_000)
    this.clock = options.clock ?? (() => Date.now())
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this.entries.size
  }

  /** Total characters retained in keys — diagnostics for memory bounds. */
  retainedKeyChars(): number {
    let n = 0
    for (const key of this.entries.keys()) n += key.length
    return n
  }

  private live(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key)
    if (entry && now >= entry.resetAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  private store(key: string, entry: Entry, now: number): void {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      for (const [k, e] of this.entries) if (now >= e.resetAt) this.entries.delete(k)
      // Still full: evict the oldest entries (Map iterates in insertion order).
      for (const k of this.entries.keys()) {
        if (this.entries.size < this.maxEntries) break
        this.entries.delete(k)
      }
    }
    this.entries.set(key, entry)
  }

  hit(key: string, windowMs: number): ThrottleWindow {
    const now = this.clock()
    const entry = this.live(key, now) ?? { count: 0, resetAt: now + windowMs }
    entry.count += 1
    this.store(key, entry, now)
    return { count: entry.count, retryAfterMs: entry.resetAt - now }
  }

  peek(key: string): ThrottleWindow | null {
    const now = this.clock()
    const entry = this.live(key, now)
    return entry ? { count: entry.count, retryAfterMs: entry.resetAt - now } : null
  }

  release(key: string): void {
    const entry = this.live(key, this.clock())
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) this.entries.delete(key)
  }

  reset(key: string): void {
    this.entries.delete(key)
  }
}

export interface LoginThrottleOptions {
  /** Failed attempts allowed within the window. Default 5. */
  maxAttempts?: number
  /** Fixed window in ms, opened by the first attempt. Default 15 minutes. */
  windowMs?: number
  /**
   * Where the counters live. Default: a private {@link MemoryThrottleStore}
   * (per process). Pass a shared store — e.g. {@link RedisThrottleStore} — to
   * enforce one budget across every replica.
   */
  store?: ThrottleStore
  /**
   * Key prefix separating this throttle's counters from others sharing the
   * same store (Auth uses `login`, `login-ip` and `email-request`).
   */
  namespace?: string
  /** Bound of the default in-memory store (ignored with `store`). Default 100 000. */
  maxEntries?: number
  /** Injectable clock for the default in-memory store (ignored with `store`). */
  clock?: () => number
}

type Awaitable<T> = T | Promise<T>

const isPromise = <T>(value: Awaitable<T>): value is Promise<T> =>
  typeof (value as { then?: unknown } | null)?.then === 'function'

/** Runs `next` on a value that may or may not be a promise — sync in, sync out. */
function chain<T, R>(value: Awaitable<T>, next: (resolved: T) => R): Awaitable<R> {
  return isPromise(value) ? value.then(next) : next(value)
}

/**
 * Brute-force guard: counts failed logins per identifier (email) within a
 * fixed window and locks the account once the budget is spent. A successful
 * login clears the counter. Counters live in a {@link ThrottleStore}: in memory
 * per process by default, or shared across replicas (Redis).
 *
 * Identifiers are handed to the store as SHA-256 digests (fixed size, never
 * the raw email).
 *
 * Use {@link reserve} before verifying credentials: it counts the attempt
 * atomically (synchronously with the memory store, in one Redis script with a
 * shared one), so a parallel burst cannot run more verifications than the
 * budget allows. {@link release} gives the reservation back on success.
 *
 * Every method returns synchronously with a synchronous store (the default)
 * and a promise otherwise; `await` the result when the store may be async.
 */
export class LoginThrottle {
  private readonly store: ThrottleStore
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly prefix: string

  constructor(options: LoginThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.windowMs = options.windowMs ?? 15 * 60_000
    this.prefix = options.namespace ? `${options.namespace}:` : ''
    this.store =
      options.store ??
      new MemoryThrottleStore({
        ...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
      })
  }

  /** Number of identifiers currently tracked (in-memory store only; 0 otherwise). */
  get size(): number {
    return this.store instanceof MemoryThrottleStore ? this.store.size : 0
  }

  /** Total characters retained in keys — diagnostics for memory bounds (in-memory store only). */
  retainedKeyChars(): number {
    return this.store instanceof MemoryThrottleStore ? this.store.retainedKeyChars() : 0
  }

  private key(key: string): string {
    return `${this.prefix}${createHash('sha256').update(key).digest('base64url')}`
  }

  /** Throws {@link AccountLockedError} when the key is currently locked. */
  assertAllowed(key: string): Awaitable<void> {
    return chain(this.store.peek(this.key(key)), (window) => {
      if (window && window.count >= this.maxAttempts) throw new AccountLockedError(window.retryAfterMs)
    })
  }

  recordFailure(key: string): Awaitable<void> {
    return chain(this.store.hit(this.key(key), this.windowMs), () => undefined)
  }

  /**
   * Atomically counts this attempt and throws {@link AccountLockedError} when
   * it exceeds the budget. Pair with {@link release} on success; a failure
   * simply keeps the reservation.
   */
  reserve(key: string): Awaitable<void> {
    return chain(this.store.hit(this.key(key), this.windowMs), (window) => {
      if (window.count > this.maxAttempts) throw new AccountLockedError(window.retryAfterMs)
    })
  }

  /** Returns one reservation (a successful attempt must not consume budget). */
  release(key: string): Awaitable<void> {
    return this.store.release(this.key(key))
  }

  reset(key: string): Awaitable<void> {
    return this.store.reset(this.key(key))
  }
}
