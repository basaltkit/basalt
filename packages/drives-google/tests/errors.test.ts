import { describe, expect, it } from 'vitest'
import { isRetryable } from '@basaltkit/drives'
import { errorReason, toGoogleError } from '../src/errors.js'
import { connect, harness } from './helpers.js'

const CONTEXT = { provider: 'google', connectionId: 'c1' }

function body(reason: string, status: number, domain = 'global'): string {
  return JSON.stringify({ error: { errors: [{ domain, reason, message: 'Something' }], code: status } })
}

describe('a throttle is a 403, and mapping by status alone would be terminal', () => {
  it.each(['userRateLimitExceeded', 'rateLimitExceeded', 'sharingRateLimitExceeded', 'dailyLimitExceeded'])(
    'maps 403 %s to DRIVE_RATE_LIMITED',
    (reason) => {
      const error = toGoogleError(403, body(reason, 403, 'usageLimits'), CONTEXT)
      expect((error as { code?: string }).code).toBe('DRIVE_RATE_LIMITED')
      // The whole point: a throttle must be retried, and DRIVE_ACCESS_DENIED
      // is terminal. Getting this wrong fails a job permanently over a
      // condition that clears itself in a second.
      expect(isRetryable(error)).toBe(true)
    },
  )

  it('maps a genuine permission refusal to DRIVE_ACCESS_DENIED, and keeps it terminal', () => {
    const error = toGoogleError(403, body('insufficientPermissions', 403), CONTEXT)
    expect((error as { code?: string }).code).toBe('DRIVE_ACCESS_DENIED')
    // Re-consenting cannot fix a file the tenant is not allowed to read, and
    // retrying cannot either.
    expect(isRetryable(error)).toBe(false)
  })

  it('does not call an unrecognised 403 a permission refusal', () => {
    // Claiming it is a permission decision tells a tenant to fix something
    // that may not be theirs to fix.
    const error = toGoogleError(403, body('somethingNew', 403), CONTEXT)
    expect((error as { code?: string }).code).toBe('DRIVE_PROVIDER_ERROR')
    expect(isRetryable(error)).toBe(false)
  })

  it('keeps storageQuotaExceeded terminal — waiting does not create disk space', () => {
    const error = toGoogleError(403, body('storageQuotaExceeded', 403, 'usageLimits'), CONTEXT)
    expect((error as { code?: string }).code).toBe('DRIVE_PROVIDER_ERROR')
    expect(isRetryable(error)).toBe(false)
  })

  it('retries a real 403 throttle end to end, through the engine', async () => {
    const h = harness({ server: { files: [{ id: 'f1', name: 'a.pdf', content: 'a' }], pageSize: 50 } })
    const view = await connect(h)
    h.google.throttleNextCalls = 2

    // Three attempts, the first two throttled: the call succeeds because the
    // adapter recognised a 403 body as a rate limit.
    const page = await h.drives.listItems(view.id)
    expect(page.items).toHaveLength(1)
    expect(h.google.requests.filter((r) => r.url.includes('/drive/v3/files?'))).toHaveLength(3)
  })
})

describe('the rest of the taxonomy', () => {
  it('maps 401 to DRIVE_CREDENTIALS_INVALID', () => {
    const error = toGoogleError(401, body('authError', 401), CONTEXT)
    expect((error as { code?: string }).code).toBe('DRIVE_CREDENTIALS_INVALID')
  })

  it('maps 404 to DRIVE_ITEM_NOT_FOUND', () => {
    const error = toGoogleError(404, body('notFound', 404), { ...CONTEXT, externalId: 'f1' })
    expect((error as { code?: string }).code).toBe('DRIVE_ITEM_NOT_FOUND')
    expect((error as { details?: { externalId?: string } }).details?.externalId).toBe('f1')
  })

  it('reads an aged-out page token as a cursor reset ONLY on a call that carried one', () => {
    const invalid = body('invalid', 400)
    expect((toGoogleError(400, invalid, { ...CONTEXT, cursor: true }) as { code?: string }).code).toBe(
      'DRIVE_CURSOR_RESET',
    )
    // Google has no distinct code for an expired token, so the same body from
    // any other endpoint is a bug in the request, not a dead cursor — and must
    // not silently restart a tenant's feed.
    expect((toGoogleError(400, invalid, CONTEXT) as { code?: string }).code).toBe('DRIVE_PROVIDER_ERROR')
  })

  it('retries a 5xx and nothing else', () => {
    expect(isRetryable(toGoogleError(503, body('backendError', 503), CONTEXT))).toBe(true)
    expect(isRetryable(toGoogleError(400, body('badRequest', 400), CONTEXT))).toBe(false)
  })

  it('maps a 429 too, in case one ever reaches the adapter', () => {
    // The guarded fetch normally intercepts 429/503 before an adapter sees
    // them; this keeps the classification right if a transport hands one
    // through.
    expect((toGoogleError(429, body('rateLimitExceeded', 429), CONTEXT) as { code?: string }).code).toBe(
      'DRIVE_RATE_LIMITED',
    )
  })
})

describe('what reaches `details`, which is serialised into responses and stored', () => {
  it('keeps Google’s own vocabulary', () => {
    expect(errorReason(body('insufficientFilePermissions', 403), 403)).toBe('insufficientFilePermissions')
  })

  it('accepts the newer google.rpc shape', () => {
    expect(errorReason(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), 403)).toBe(
      'PERMISSION_DENIED',
    )
  })

  it('accepts the OAuth shape', () => {
    expect(errorReason(JSON.stringify({ error: 'invalid_grant' }), 400)).toBe('invalid_grant')
  })

  it('refuses anything that is not a fixed vocabulary token', () => {
    // An HTML page from a proxy, a stack trace, a message an attacker
    // influenced — none of it belongs in a payload `@basaltkit/audit` stores.
    expect(errorReason('<html><body>502 Bad Gateway</body></html>', 502)).toBe('http_502')
    expect(errorReason(body('a reason with spaces and <script>', 403), 403)).toBe('http_403')
    expect(errorReason('', 500)).toBe('http_500')
  })

  it('never carries Google’s free-text message', () => {
    const raw = JSON.stringify({
      error: { errors: [{ reason: 'notFound', message: 'File not found: secret-project-q4.pdf.' }], code: 404 },
    })
    const error = toGoogleError(404, raw, CONTEXT)
    const serialised = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    })
    expect(serialised).not.toContain('secret-project-q4')
  })

  it('never carries a token, a header or a URL', async () => {
    const h = harness({ server: { files: [{ id: 'f1', name: 'a.pdf', content: 'a' }] } })
    const view = await connect(h)
    h.google.queue(403, body('insufficientPermissions', 403))

    const error = await h.drives.listItems(view.id).catch((e: unknown) => e)
    const serialised = JSON.stringify({
      message: (error as Error).message,
      details: (error as { details?: unknown }).details,
    })
    expect(serialised).not.toContain('Bearer')
    expect(serialised).not.toContain('access-')
    expect(serialised).not.toContain('refresh-')
    expect(serialised).not.toContain('https://')
  })
})
