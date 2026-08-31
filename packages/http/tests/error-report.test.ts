import { describe, expect, it, vi } from 'vitest'
import { httpErrorReporter, reportHttpError, type HttpLogSink } from '../src/error-report.js'

/**
 * The POLICY every adapter shares. Which statuses are reported, and at which
 * level, is decided here exactly once — the adapters only choose where the
 * records go. Their own suites assert that they call this; this one asserts
 * what it does.
 */

const sink = () => ({
  error: vi.fn<(...args: unknown[]) => void>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
})

const report = (status: number, error: unknown = new Error('boom')) => ({
  error,
  status,
  code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
  method: 'POST',
  url: '/plans',
})

describe('HTTP error reporting policy', () => {
  it('sends 5xx to error, WITH the error object so the stack survives', () => {
    const log = sink()
    const boom = new Error('boom')
    reportHttpError(report(500, boom), log)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.warn).not.toHaveBeenCalled()
    // The error object itself is passed, not a string — a 500 is a bug and the
    // trace is the whole point.
    expect(log.error.mock.calls[0]![1]).toBe(boom)
    expect(log.error.mock.calls[0]![0]).toContain('POST /plans → 500 INTERNAL_ERROR')
  })

  it('sends 4xx to warn, as one line — a validation stack is noise', () => {
    const log = sink()
    reportHttpError(report(400, new Error('body.price: expected number')), log)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn.mock.calls[0]![0]).toContain('POST /plans → 400 VALIDATION_ERROR')
    expect(log.warn.mock.calls[0]![0]).toContain('body.price: expected number')
    expect(log.warn.mock.calls[0]).toHaveLength(1)
  })

  it('stays silent below 400 — a 302 is not a failure', () => {
    const log = sink()
    reportHttpError({ ...report(500), status: 302 }, log)
    reportHttpError({ ...report(500), status: 200 }, log)
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('never lets a broken sink escalate a handled error into a crash', () => {
    // The reporter runs INSIDE the error handler. If a logging transport throws
    // here, a tidy 400 would turn into an unhandled exception mid-response.
    const exploding: HttpLogSink = {
      error() { throw new Error('transport down') },
      warn() { throw new Error('transport down') },
    }
    expect(() => reportHttpError(report(500), exploding)).not.toThrow()
    expect(() => reportHttpError(report(400), exploding)).not.toThrow()
  })

  it('renders a non-Error throw without blowing up', () => {
    const log = sink()
    reportHttpError({ ...report(400), error: 'just a string' }, log)
    expect(log.warn.mock.calls[0]![0]).toContain('just a string')
  })

  it('httpErrorReporter binds a sink and defaults to console', () => {
    const log = sink()
    httpErrorReporter(log)(report(500))
    expect(log.error).toHaveBeenCalledTimes(1)

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      httpErrorReporter()(report(404))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })
})
