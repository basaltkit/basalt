import { describe, expect, it } from 'vitest'
import { errorCode, toGraphError } from '../src/index.js'

const context = { provider: 'microsoft', connectionId: 'conn-1' }

const body = (code: string, message = 'human readable text'): string =>
  JSON.stringify({ error: { code, message, innerError: { 'request-id': 'abc-123', date: '2026-06-01' } } })

describe('reading a Graph error', () => {
  it('keeps the code, which is a fixed vocabulary', () => {
    expect(errorCode(body('itemNotFound'), 404)).toBe('itemNotFound')
    expect(errorCode(body('resyncRequired'), 410)).toBe('resyncRequired')
  })

  it('refuses anything that is not a Graph code', () => {
    // An HTML error page from a proxy, a truncated body, a message somebody
    // influenced. `details` is serialised into the HTTP response and stored by
    // `@basaltkit/audit`, so only a value shaped like Graph's own taxonomy is
    // ever forwarded.
    expect(errorCode('<html>504 Gateway Timeout</html>', 504)).toBe('http_504')
    expect(errorCode(JSON.stringify({ error: { code: 'a'.repeat(200) } }), 400)).toBe('http_400')
    expect(errorCode(JSON.stringify({ error: { code: 'https://cdn/x?tempauth=SECRET' } }), 403)).toBe('http_403')
    expect(errorCode('', 500)).toBe('http_500')
  })

  it('never forwards the message, which quotes the request', () => {
    const error = toGraphError(404, body('itemNotFound', 'Item not found: https://cdn/x?tempauth=SECRET'), context)
    const serialised = JSON.stringify({ message: error.message, details: (error as { details?: unknown }).details })
    expect(serialised).not.toContain('tempauth')
    expect(serialised).not.toContain('SECRET')
    // …and the innerError's request-id has nowhere to go in the contract's
    // error shape, so it is not smuggled into the summary either.
    expect(serialised).not.toContain('abc-123')
  })
})

describe('the mapping', () => {
  const cases: [number, string, string, boolean][] = [
    // status, code, expected DRIVE_ code, retryable
    [401, 'InvalidAuthenticationToken', 'DRIVE_CREDENTIALS_INVALID', false],
    [403, 'accessDenied', 'DRIVE_ACCESS_DENIED', false],
    [403, 'notAllowed', 'DRIVE_ACCESS_DENIED', false],
    [404, 'itemNotFound', 'DRIVE_ITEM_NOT_FOUND', false],
    [410, 'resyncRequired', 'DRIVE_CURSOR_RESET', false],
    [409, 'nameAlreadyExists', 'DRIVE_PROVIDER_ERROR', false],
    [423, 'resourceLocked', 'DRIVE_PROVIDER_ERROR', true],
    [507, 'quotaLimitReached', 'DRIVE_PROVIDER_ERROR', false],
    [500, 'generalException', 'DRIVE_PROVIDER_ERROR', true],
    [503, 'serviceNotAvailable', 'DRIVE_PROVIDER_ERROR', true],
  ]

  for (const [status, code, expected, retryable] of cases) {
    it(`maps ${status} ${code} to ${expected}${retryable ? ' (retryable)' : ''}`, () => {
      const error = toGraphError(status, body(code), context)
      expect((error as { code?: string }).code).toBe(expected)
      if (expected === 'DRIVE_PROVIDER_ERROR') {
        expect((error as { retryable?: boolean }).retryable).toBe(retryable)
      }
    })
  }

  it('keeps a 403 apart from a 401, because re-consenting cannot fix one of them', () => {
    // A missing `Sites.Read.All`, a sensitivity label or a conditional-access
    // policy answers 403 with a perfectly valid token. Folding that into
    // "reconnect your account" tells a tenant to re-consent for ever over
    // something re-consenting cannot fix.
    expect((toGraphError(403, body('accessDenied'), context) as { code?: string }).code).toBe('DRIVE_ACCESS_DENIED')
    expect((toGraphError(401, body('x'), context) as { code?: string }).code).toBe('DRIVE_CREDENTIALS_INVALID')
  })

  it('treats any 410 on the change feed as a cursor reset', () => {
    // The cursor is PERSISTED. Anything but dropping it fails every future run
    // of that connection identically, for ever.
    const error = toGraphError(410, body('gone'), { ...context, delta: true })
    expect((error as { code?: string }).code).toBe('DRIVE_CURSOR_RESET')
    // Off the change feed, a 410 is just a thing that is gone.
    expect((toGraphError(410, body('gone'), context) as { code?: string }).code).toBe('DRIVE_ITEM_NOT_FOUND')
  })
})
