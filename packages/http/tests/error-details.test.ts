/**
 * BK-021 — structured, client-visible error payloads.
 *
 * `new HttpError(status, code, message, { details })` gives a domain error a
 * machine-readable body the UI can act on, instead of forcing the app to parse
 * codes out of a human sentence. Everything here is about the guarantees that
 * make that safe: only explicitly constructed errors carry details, the payload
 * is plain JSON data, and it is bounded.
 */
import { BasaltError } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import {
  HttpError,
  MAX_ERROR_DETAILS_BYTES,
  MAX_ERROR_DETAILS_DEPTH,
  RequestValidationError,
  sanitizeErrorDetails,
  toErrorResponse,
} from '../src/index.js'

/** A domain error the way packages outside HTTP raise one: BasaltError + numeric `status`. */
class QuotaExceededError extends BasaltError {
  readonly status = 402
  constructor(details: Record<string, unknown>) {
    super('QUOTA_EXCEEDED', 'Plan quota exceeded.', { details })
  }
}

describe('HttpError details — the constructor', () => {
  it('keeps the 3-argument form working, and adds no details key to the body', () => {
    const error = new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found')
    expect(error.status).toBe(404)
    expect(error.code).toBe('PROJECT_NOT_FOUND')
    expect(error.details).toBeUndefined()
    expect(toErrorResponse(error)).toEqual({
      status: 404,
      body: { error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } },
    })
    expect('details' in toErrorResponse(error).body.error).toBe(false)
  })

  it('takes an options object — details and the standard `cause` together', () => {
    const cause = new Error('upstream')
    const error = new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', {
      details: { failed: ['age', 'address'] },
      cause,
    })
    expect(error.cause).toBe(cause)
    expect(error.details).toEqual({ failed: ['age', 'address'] })
  })

  it('serializes details as error.details', () => {
    const error = new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', {
      details: { failed: ['age', 'address'], remaining: 2, retryable: true },
    })
    expect(toErrorResponse(error)).toEqual({
      status: 422,
      body: {
        error: {
          code: 'CHECKS_FAILED',
          message: 'Checks failed.',
          details: { failed: ['age', 'address'], remaining: 2, retryable: true },
        },
      },
    })
  })

  it('serializes details on a BasaltError with a status, the same way', () => {
    expect(toErrorResponse(new QuotaExceededError({ limit: 100, used: 100 }))).toEqual({
      status: 402,
      body: { error: { code: 'QUOTA_EXCEEDED', message: 'Plan quota exceeded.', details: { limit: 100, used: 100 } } },
    })
  })

  it('keeps details on a deliberately constructed 5xx (it is not an unexpected exception)', () => {
    const error = new HttpError(503, 'MAINTENANCE', 'Down for maintenance.', { details: { until: '2026-01-01T00:00:00.000Z' } })
    expect(toErrorResponse(error).body.error.details).toEqual({ until: '2026-01-01T00:00:00.000Z' })
  })
})

describe('HttpError details — what never reaches the client', () => {
  it('leaves a plain thrown Error as the neutral 500, with no details', () => {
    const error = Object.assign(new Error('boom'), { details: { secret: 'shhh' } })
    expect(toErrorResponse(error)).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' } },
    })
  })

  it('adds nothing to a framework client error (malformed JSON body)', () => {
    const parse = Object.assign(new SyntaxError('Unexpected token'), { statusCode: 400, details: { body: 'secret' } })
    expect(toErrorResponse(parse).body.error).toEqual({ code: 'BAD_REQUEST', message: 'Malformed request.' })
  })

  it('leaves the validation body exactly as it was — part and issues, no details', () => {
    const body = toErrorResponse(new RequestValidationError('body', [{ path: 'name', message: 'Required' }])).body
    expect(body).toEqual({
      error: {
        code: 'HTTP_VALIDATION',
        message: 'Validation failed in body',
        part: 'body',
        issues: [{ path: 'name', message: 'Required' }],
      },
    })
  })
})

describe('sanitizeErrorDetails', () => {
  it('keeps plain JSON data untouched', () => {
    const details = { a: 'x', b: 1, c: true, d: null, e: [1, 'two', { f: false }], g: { h: { i: 'deep' } } }
    expect(sanitizeErrorDetails(details)).toEqual(details)
  })

  it('strips values JSON cannot carry, instead of rejecting the whole payload', () => {
    expect(
      sanitizeErrorDetails({
        keep: 'yes',
        fn: () => 'no',
        undef: undefined,
        sym: Symbol('no'),
        big: 10n,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ keep: 'yes' })
  })

  it('turns a dropped array element into null, so later indexes do not shift', () => {
    expect(sanitizeErrorDetails({ list: ['a', () => 'no', 'c'] })).toEqual({ list: ['a', null, 'c'] })
  })

  it('renders a Date as an ISO string and drops an invalid one', () => {
    expect(sanitizeErrorDetails({ at: new Date('2026-01-02T03:04:05.000Z') })).toEqual({ at: '2026-01-02T03:04:05.000Z' })
    expect(sanitizeErrorDetails({ at: new Date('nope') })).toBeUndefined()
  })

  it('drops values that are not plain data — Error, Map, Set, RegExp, class instances', () => {
    class Row {
      constructor(readonly passwordHash: string) {}
    }
    expect(
      sanitizeErrorDetails({
        keep: 1,
        err: new Error('stack and message are internals'),
        map: new Map([['a', 1]]),
        set: new Set([1]),
        re: /secret/,
        row: new Row('$2b$…'),
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).toEqual({ keep: 1 })
  })

  it('drops a cycle instead of throwing', () => {
    const node: Record<string, unknown> = { name: 'a' }
    node['self'] = node
    node['children'] = [node]
    expect(sanitizeErrorDetails(node)).toEqual({ name: 'a', children: [null] })
  })

  it('drops anything nested deeper than the depth cap', () => {
    let leaf: Record<string, unknown> = { bottom: true }
    for (let i = 0; i < MAX_ERROR_DETAILS_DEPTH + 2; i += 1) leaf = { next: leaf }
    const clean = sanitizeErrorDetails(leaf)
    let node = clean as Record<string, unknown> | undefined
    let depth = 0
    while (node && typeof node['next'] === 'object' && node['next'] !== null) {
      node = node['next'] as Record<string, unknown>
      depth += 1
    }
    expect(depth).toBeLessThanOrEqual(MAX_ERROR_DETAILS_DEPTH)
    expect(JSON.stringify(clean)).not.toContain('bottom')
  })

  it('never lets a key named __proto__ through', () => {
    const details = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<string, unknown>
    const clean = sanitizeErrorDetails(details)
    expect(clean).toEqual({ ok: 1 })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('drops the whole payload when it is over the size cap', () => {
    const big = { note: 'x'.repeat(MAX_ERROR_DETAILS_BYTES) }
    expect(sanitizeErrorDetails(big)).toBeUndefined()
    const fits = { note: 'x'.repeat(MAX_ERROR_DETAILS_BYTES - 64) }
    expect(sanitizeErrorDetails(fits)).toEqual(fits)
  })

  it('rejects anything that is not a plain object of data', () => {
    expect(sanitizeErrorDetails(undefined)).toBeUndefined()
    expect(sanitizeErrorDetails(null)).toBeUndefined()
    expect(sanitizeErrorDetails('string')).toBeUndefined()
    expect(sanitizeErrorDetails([1, 2, 3])).toBeUndefined()
    expect(sanitizeErrorDetails({})).toBeUndefined()
    expect(sanitizeErrorDetails({ onlyJunk: () => 1 })).toBeUndefined()
  })

  it('does not explode when a getter throws', () => {
    const details = {
      get boom(): string {
        throw new Error('getter')
      },
    }
    expect(sanitizeErrorDetails(details)).toBeUndefined()
  })
})

describe('toErrorResponse and unsafe details', () => {
  it('omits the key entirely when the payload is oversized', () => {
    const error = new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', {
      details: { blob: 'x'.repeat(MAX_ERROR_DETAILS_BYTES * 2) },
    })
    expect(toErrorResponse(error)).toEqual({
      status: 422,
      body: { error: { code: 'CHECKS_FAILED', message: 'Checks failed.' } },
    })
  })

  it('sends the sanitised copy, never the live object the app passed', () => {
    const live = { failed: ['age'], onRetry: () => 'no' }
    const error = new HttpError(422, 'CHECKS_FAILED', 'Checks failed.', { details: live })
    const { body } = toErrorResponse(error)
    expect(body.error.details).toEqual({ failed: ['age'] })
    expect(body.error.details).not.toBe(live)
    expect(error.details).toBe(live)
  })
})
