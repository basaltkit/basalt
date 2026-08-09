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
  /** Injectable clock for tests. */
  clock?: () => number
}

/**
 * Brute-force guard: counts failed logins per identifier (email) within a
 * rolling window and locks the account once the budget is spent. A successful
 * login clears the counter. In-memory per process; back it with Redis for a
 * cluster by supplying the same behavior.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  private readonly clock: () => number

  constructor(options: LoginThrottleOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 5
    this.windowMs = options.windowMs ?? 15 * 60_000
    this.clock = options.clock ?? (() => Date.now())
  }

  /** Throws {@link AccountLockedError} when the key is currently locked. */
  assertAllowed(key: string): void {
    const entry = this.failures.get(key)
    if (entry && this.clock() < entry.resetAt && entry.count >= this.maxAttempts) {
      throw new AccountLockedError(entry.resetAt - this.clock())
    }
  }

  recordFailure(key: string): void {
    const now = this.clock()
    let entry = this.failures.get(key)
    if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + this.windowMs }
    entry.count += 1
    this.failures.set(key, entry)
  }

  reset(key: string): void {
    this.failures.delete(key)
  }
}
