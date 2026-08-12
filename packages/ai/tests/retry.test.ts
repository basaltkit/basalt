import { describe, expect, it } from 'vitest'
import { fetchWithRetry, type FetchLike } from '../src/index.js'

/** A fetch that returns the given status sequence, one per call. */
function scriptedFetch(statuses: number[]): FetchLike & { calls: number } {
  const fn = (async () => {
    const status = statuses[fn.calls] ?? statuses[statuses.length - 1] ?? 200
    fn.calls += 1
    return { ok: status >= 200 && status < 300, status, text: async () => `body-${status}` }
  }) as unknown as FetchLike & { calls: number }
  fn.calls = 0
  return fn
}

describe('fetchWithRetry', () => {
  it('retries a transient 500 then succeeds', async () => {
    const fetch = scriptedFetch([500, 200])
    const res = await fetchWithRetry(fetch, 'u', {}, { baseDelayMs: 0 })
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    expect(fetch.calls).toBe(2)
  })

  it('gives up after the retry budget on persistent 500', async () => {
    const fetch = scriptedFetch([500])
    const res = await fetchWithRetry(fetch, 'u', {}, { retries: 2, baseDelayMs: 0 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(500)
    expect(fetch.calls).toBe(3) // 1 + 2 retries
  })

  it('does not retry a 4xx (client error)', async () => {
    const fetch = scriptedFetch([401, 200])
    const res = await fetchWithRetry(fetch, 'u', {}, { baseDelayMs: 0 })
    expect(res.status).toBe(401)
    expect(fetch.calls).toBe(1)
  })

  it('retries a 429 rate limit', async () => {
    const fetch = scriptedFetch([429, 200])
    const res = await fetchWithRetry(fetch, 'u', {}, { baseDelayMs: 0 })
    expect(res.status).toBe(200)
    expect(fetch.calls).toBe(2)
  })

  it('retries a network error then succeeds', async () => {
    let calls = 0
    const fetch: FetchLike = async () => {
      calls += 1
      if (calls === 1) throw new Error('ECONNRESET')
      return { ok: true, status: 200, text: async () => 'ok' }
    }
    const res = await fetchWithRetry(fetch, 'u', {}, { baseDelayMs: 0 })
    expect(res.status).toBe(200)
    expect(calls).toBe(2)
  })
})
