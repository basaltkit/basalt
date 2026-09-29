/**
 * FA-H05 / BK-050 — `details` is public by construction.
 *
 * `sanitizeErrorDetails` bounds the SHAPE of an error payload; these cover
 * what it could not: a log-only channel (`internalDetails`) that never reaches
 * a response, and a pluggable redactor for keys that name a secret.
 */
import { BasaltError } from '@basaltkit/core'
import { describe, expect, it, vi } from 'vitest'
import {
  HttpError,
  REDACTED_DETAIL,
  internalDetailsOf,
  isSensitiveDetailsKey,
  redactSensitiveDetails,
  reportHttpError,
  toErrorResponse,
  type ErrorDetailsRedactor,
} from '../src/index.js'

const sink = () => ({
  error: vi.fn<(fields: Record<string, unknown>, message: string) => void>(),
  warn: vi.fn<(fields: Record<string, unknown>, message: string) => void>(),
})

describe('internalDetails — the log-only channel', () => {
  const error = new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', {
    details: { failed: ['age'] },
    internalDetails: { upstream: 'kyc-provider', reply: 'account 991 frozen' },
  })

  it('is kept on the error but never serialised into the response body', () => {
    expect(error.internalDetails).toEqual({ upstream: 'kyc-provider', reply: 'account 991 frozen' })
    const { body } = toErrorResponse(error)
    expect(body).toEqual({ error: { code: 'CHECKS_FAILED', message: 'Checks failed.', details: { failed: ['age'] } } })
    expect(JSON.stringify(body)).not.toContain('frozen')
  })

  it('is non-enumerable, so spreading or stringifying the error leaves it behind', () => {
    expect(Object.keys(error)).not.toContain('internalDetails')
    expect(JSON.stringify({ ...error })).not.toContain('frozen')
  })

  it('reaches the default reporter, for 4xx and 5xx alike', () => {
    const log = sink()
    reportHttpError({ error, status: 422, code: 'CHECKS_FAILED', method: 'POST', url: '/kyc' }, log)
    expect(log.warn.mock.calls[0]![0]['internalDetails']).toEqual({
      upstream: 'kyc-provider',
      reply: 'account 991 frozen',
    })

    const fatal = new HttpError(500, 'BROKEN', 'Broken.', { internalDetails: { job: 'j-7' } })
    reportHttpError({ error: fatal, status: 500, code: 'BROKEN', method: 'GET', url: '/' }, log)
    expect(log.error.mock.calls[0]![0]['internalDetails']).toEqual({ job: 'j-7' })
  })

  it('is read from any error that defines one, sanitised for shape', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(internalDetailsOf(Object.assign(new Error('x'), { internalDetails: cyclic }))).toEqual({ a: 1 })
    expect(internalDetailsOf(new Error('x'))).toBeUndefined()
    expect(internalDetailsOf(null)).toBeUndefined()
    const log = sink()
    reportHttpError({ error: new Error('x'), status: 500, code: 'INTERNAL_ERROR', method: 'GET', url: '/' }, log)
    expect('internalDetails' in log.error.mock.calls[0]![0]).toBe(false)
  })
})

describe('isSensitiveDetailsKey', () => {
  it.each(['password', 'resetToken', 'api_key', 'apiKey', 'X-Private-Key', 'jwt', 'sessionId', 'clientSecret', 'otp'])(
    'flags %s',
    (key) => expect(isSensitiveDetailsKey(key)).toBe(true),
  )
  it.each(['compass', 'bypass', 'sessionCount', 'author', 'keyId', 'connectionId', 'failed', 'remaining'])(
    'leaves %s alone',
    (key) => expect(isSensitiveDetailsKey(key)).toBe(false),
  )
})

describe('redactSensitiveDetails', () => {
  it('masks sensitive values at any depth, keeps booleans/null and everything else', () => {
    expect(
      redactSensitiveDetails({
        failed: ['age'],
        password: 'hunter2',
        mfaRequired: true,
        token: null,
        nested: { accessToken: 'abc', ok: 1, list: [{ secret: 's' }] },
        credentials: { user: 'u', pass: 'p' },
      }),
    ).toEqual({
      failed: ['age'],
      password: REDACTED_DETAIL,
      mfaRequired: true,
      token: null,
      nested: { accessToken: REDACTED_DETAIL, ok: 1, list: [{ secret: REDACTED_DETAIL }] },
      credentials: REDACTED_DETAIL,
    })
  })
})

describe('toErrorResponse({ redactDetails })', () => {
  const error = new HttpError(409, 'CONFLICT', 'Conflict.', { details: { version: 3, resetToken: 'r-123' } })

  it('sends details as sanitised when no redactor is given (backwards compatible)', () => {
    expect(toErrorResponse(error).body.error.details).toEqual({ version: 3, resetToken: 'r-123' })
  })

  it('applies the default redactor when asked', () => {
    expect(toErrorResponse(error, { redactDetails: redactSensitiveDetails }).body.error.details).toEqual({
      version: 3,
      resetToken: REDACTED_DETAIL,
    })
  })

  it('hands a custom redactor the error, status and code; re-sanitises its output', () => {
    const redact = vi.fn<ErrorDetailsRedactor>(() => ({ kept: 1, fn: () => 0 }) as never)
    expect(toErrorResponse(error, { redactDetails: redact }).body.error.details).toEqual({ kept: 1 })
    expect(redact).toHaveBeenCalledWith({ version: 3, resetToken: 'r-123' }, { error, status: 409, code: 'CONFLICT' })
  })

  it('drops the payload when the redactor returns nothing or throws — fails closed', () => {
    expect('details' in toErrorResponse(error, { redactDetails: () => undefined }).body.error).toBe(false)
    const throwing: ErrorDetailsRedactor = () => {
      throw new Error('bad redactor')
    }
    expect(toErrorResponse(error, { redactDetails: throwing })).toEqual({
      status: 409,
      body: { error: { code: 'CONFLICT', message: 'Conflict.' } },
    })
  })

  it('applies to any BasaltError with a status, not only HttpError', () => {
    class LockedError extends BasaltError {
      readonly status = 423
      constructor() {
        super('LOCKED', 'Locked.', { details: { unlockToken: 'u-1', until: 5 } })
      }
    }
    expect(toErrorResponse(new LockedError(), { redactDetails: redactSensitiveDetails }).body.error.details).toEqual({
      unlockToken: REDACTED_DETAIL,
      until: 5,
    })
  })
})
