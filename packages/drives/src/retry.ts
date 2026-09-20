import { DriveProviderError, DriveRateLimitedError } from './errors.js'

/**
 * Retry with exponential backoff and full jitter, honouring the provider's own
 * `Retry-After` when it gave one.
 *
 * This lives here rather than in each adapter because rate limiting is the one
 * thing every file API does and every adapter would get subtly wrong. Three
 * decisions are worth stating:
 *
 * - **`Retry-After` wins over our own schedule.** A provider that says "wait 42
 *   seconds" has told us what its limiter will accept; retrying at our own
 *   pace just burns the remaining quota.
 * - **Full jitter, not fixed backoff.** A sync that fans out across a tenant's
 *   folders hits the limiter with a herd; identical backoff reconverges the
 *   herd on the same instant. `random() * delay` spreads it.
 * - **Only transient failures retry.** A 401 that survived a refresh, a 403, a
 *   404 and every {@link DriveCredentialsInvalidError} are terminal — retrying
 *   them is how an app turns one broken connection into a sustained attack on
 *   the provider and gets the whole *application* throttled, not just one
 *   tenant.
 */

export interface DriveRetryPolicy {
  /** Total attempts including the first. Default 3. */
  attempts?: number
  /** First backoff step. Doubles each attempt. Default 500 ms. */
  baseDelayMs?: number
  /** Ceiling for one wait. Default 30 s. */
  maxDelayMs?: number
  /**
   * Longest a provider-supplied `Retry-After` may hold a worker.
   *
   * Providers occasionally answer with hours. Blocking a queue worker for an
   * hour is worse than failing the job and letting the queue's own backoff
   * re-run it later, so anything above this gives up instead of sleeping.
   * Default 60 s.
   */
  maxRetryAfterMs?: number
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>
  /** Injected randomness (tests). Must return [0, 1). */
  random?: () => number
  /** Observer for each retry — for metrics and logs. Never receives credentials. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether an error is worth trying again.
 *
 * Deliberately conservative: anything not recognisably transient is treated as
 * terminal. Retrying an unknown failure is the default that produces runaway
 * loops against a third party.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof DriveRateLimitedError) return true
  // The one `DRIVE_` code that is a *fault* rather than a decision: an adapter
  // mapped a provider response it could not classify, and 5xx means the request
  // never reached a decision. The adapter says which, because only it knows the
  // vendor's taxonomy.
  if (error instanceof DriveProviderError) return error.retryable
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') {
    // Transport-level faults: the request never reached a decision.
    if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND'].includes(code)) return true
    // Everything this package raises with a DRIVE_ code is a decision, not a
    // fault — including DRIVE_CREDENTIALS_INVALID and DRIVE_HOST_NOT_ALLOWED.
    if (code.startsWith('DRIVE_')) return false
  }
  return false
}

export async function withRetry<T>(operation: () => Promise<T>, policy: DriveRetryPolicy = {}): Promise<T> {
  const attempts = Math.max(1, policy.attempts ?? 3)
  const base = policy.baseDelayMs ?? 500
  const max = policy.maxDelayMs ?? 30_000
  const maxRetryAfter = policy.maxRetryAfterMs ?? 60_000
  const sleep = policy.sleep ?? defaultSleep
  const random = policy.random ?? Math.random

  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === attempts || !isRetryable(error)) throw error

      const hinted = error instanceof DriveRateLimitedError ? error.retryAfterMs : undefined
      if (hinted !== undefined && hinted > maxRetryAfter) throw error
      const delayMs =
        hinted ?? Math.round(random() * Math.min(max, base * 2 ** (attempt - 1)))
      policy.onRetry?.({ attempt, delayMs, error })
      await sleep(delayMs)
    }
  }
  throw lastError
}
