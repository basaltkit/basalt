import { describe, expect, it, vi } from 'vitest'
import { DriveCredentialsInvalidError, DriveHostNotAllowedError, DriveRateLimitedError } from '../src/errors.js'
import { isRetryable, withRetry } from '../src/retry.js'
import { connect, harness } from './helpers.js'

const noSleep = { sleep: async () => {}, random: () => 0 }

describe('isRetryable', () => {
  it('retries a rate-limit', () => {
    expect(isRetryable(new DriveRateLimitedError(1000, 'fake'))).toBe(true)
  })

  it('retries transport faults', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']) {
      expect(isRetryable(Object.assign(new Error('net'), { code }))).toBe(true)
    }
  })

  it('never retries invalid credentials', () => {
    // Retrying this is how one broken connection gets the whole application
    // throttled by the provider, not just one tenant.
    expect(isRetryable(new DriveCredentialsInvalidError('c1', 'revoked'))).toBe(false)
  })

  it('never retries a blocked host', () => {
    expect(isRetryable(new DriveHostNotAllowedError('evil.test', 'fake'))).toBe(false)
  })

  it('does not retry an unknown error', () => {
    // Conservative by default: an unrecognised failure is the one most likely
    // to produce a runaway loop against a third party.
    expect(isRetryable(new Error('who knows'))).toBe(false)
  })
})

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(async () => {})
    await expect(withRetry(async () => 'ok', { ...noSleep, sleep })).resolves.toBe('ok')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries a transient failure and succeeds', async () => {
    let attempts = 0
    const result = await withRetry(async () => {
      attempts++
      if (attempts < 3) throw new DriveRateLimitedError(undefined, 'fake')
      return 'ok'
    }, { attempts: 3, ...noSleep })
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('gives up after the attempt budget', async () => {
    let attempts = 0
    await expect(
      withRetry(async () => {
        attempts++
        throw new DriveRateLimitedError(undefined, 'fake')
      }, { attempts: 3, ...noSleep }),
    ).rejects.toThrow(DriveRateLimitedError)
    expect(attempts).toBe(3)
  })

  it('does not retry a terminal failure at all', async () => {
    let attempts = 0
    await expect(
      withRetry(async () => {
        attempts++
        throw new DriveCredentialsInvalidError('c1', 'revoked')
      }, { attempts: 5, ...noSleep }),
    ).rejects.toThrow(DriveCredentialsInvalidError)
    expect(attempts).toBe(1)
  })

  it('honours the provider’s Retry-After over its own schedule', async () => {
    const waits: number[] = []
    let attempts = 0
    await withRetry(async () => {
      attempts++
      if (attempts === 1) throw new DriveRateLimitedError(4200, 'fake')
      return 'ok'
    }, { attempts: 2, sleep: async (ms) => void waits.push(ms), random: () => 0.5 })
    // The provider told us what its limiter will accept; retrying at our own
    // pace just burns the remaining quota.
    expect(waits).toEqual([4200])
  })

  it('refuses to block a worker for an absurd Retry-After', async () => {
    let attempts = 0
    await expect(
      withRetry(async () => {
        attempts++
        throw new DriveRateLimitedError(3 * 60 * 60_000, 'fake')
      }, { attempts: 3, maxRetryAfterMs: 60_000, ...noSleep }),
    ).rejects.toThrow(DriveRateLimitedError)
    // Better to fail the job and let the queue's own backoff re-run it later
    // than to hold a worker hostage for three hours.
    expect(attempts).toBe(1)
  })

  it('applies full jitter and caps the backoff', async () => {
    const waits: number[] = []
    let attempts = 0
    await expect(
      withRetry(async () => {
        attempts++
        throw new DriveRateLimitedError(undefined, 'fake')
      }, { attempts: 5, baseDelayMs: 1000, maxDelayMs: 3000, sleep: async (ms) => void waits.push(ms), random: () => 1 }),
    ).rejects.toThrow()
    // random() === 1 gives the full window: 1000, 2000, then capped at 3000.
    expect(waits).toEqual([1000, 2000, 3000, 3000])
  })

  it('reports each retry to the observer', async () => {
    const seen: number[] = []
    await withRetry(async () => 'ok', { attempts: 1, onRetry: ({ attempt }) => seen.push(attempt), ...noSleep })
    expect(seen).toEqual([])

    let attempts = 0
    await withRetry(async () => {
      attempts++
      if (attempts === 1) throw new DriveRateLimitedError(undefined, 'fake')
      return 'ok'
    }, { attempts: 2, onRetry: ({ attempt }) => seen.push(attempt), ...noSleep })
    expect(seen).toEqual([1])
  })
})

describe('retry integrated with provider calls', () => {
  it('retries a rate-limited provider call and succeeds', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    h.fake.rateLimitNextCalls = 2

    const page = await h.drives.listItems(view.id, { tenantId: 'acme' })
    expect(page.items).toHaveLength(1)
    expect(h.fake.calls['list']).toBe(3)
  })

  it('surfaces the rate limit once the budget is spent', async () => {
    const h = harness({ provider: { files: [{ externalId: 'f1', name: 'a.txt' }] } })
    const view = await connect(h, { tenantId: 'acme' })
    h.fake.rateLimitNextCalls = 10

    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveRateLimitedError)
  })
})
