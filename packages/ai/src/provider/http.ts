import type { FetchLike } from './types.js'

export interface RetryOptions {
  /** Extra attempts after the first (so `2` = up to 3 tries). */
  retries?: number
  /** Base backoff in ms; doubles each attempt. */
  baseDelayMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Transient failures worth retrying: gateway/server errors and rate limits. */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429
}

/**
 * Fetch with retry on transient 5xx/429 responses and network errors, using
 * exponential backoff. Providers hit remote gateways (go4ai, OpenAI, Anthropic)
 * that occasionally return a spurious 500 — one retry usually clears it.
 *
 * Reads the body only on the terminal attempt, so retried responses are simply
 * discarded.
 */
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  options: RetryOptions = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const retries = options.retries ?? 2
  const baseDelayMs = options.baseDelayMs ?? 300
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, init)
      if (isRetryableStatus(res.status) && attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt)
        continue
      }
      return { ok: res.ok, status: res.status, body: await res.text() }
    } catch (error) {
      lastError = error
      if (attempt >= retries) throw error
      await sleep(baseDelayMs * 2 ** attempt)
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError instanceof Error ? lastError : new Error('fetchWithRetry: exhausted retries')
}
