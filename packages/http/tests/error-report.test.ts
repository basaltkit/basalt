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

  // CodeQL flagged all three of these on the first version of this file, and it
  // was right: method, URL and the error message all come from the request.
  describe('untrusted fields cannot corrupt the log', () => {
    it('cannot forge a second log line (js/log-injection)', () => {
      const log = sink()
      const forged = '/x\nWARN  [basalt:http] GET /admin → 200 OK'
      reportHttpError({ ...report(400), url: forged }, log)
      const line = String(log.warn.mock.calls[0]![0])
      expect(line).not.toContain('\n')
      expect(line.split('\n')).toHaveLength(1)
      // The text survives, flattened — evidence is kept, structure is not.
      expect(line).toContain('/admin')
    })

    it('cannot make the logger eat the error object (js/tainted-format-string)', () => {
      // `console` and pino both treat the first argument as a format string. An
      // unescaped `%s` here would consume the SECOND argument — the error whose
      // stack is the entire reason we log a 500.
      const log = sink()
      const boom = new Error('boom')
      reportHttpError({ ...report(500, boom), url: '/x?q=%s%d%j%o' }, log)
      const [line, second] = log.error.mock.calls[0]!
      // Every run of `%` must be even-length: that is what "all escaped" means.
      // Asserting the absence of `%s` would be wrong — the escaped form `%%s`
      // contains it as a substring while being perfectly safe.
      const runs = String(line).match(/%+/g) ?? []
      expect(runs.length).toBeGreaterThan(0)
      expect(runs.every((run) => run.length % 2 === 0)).toBe(true)
      // The error still arrives as its own argument, stack intact.
      expect(second).toBe(boom)
    })

    it('caps a huge field instead of flooding the log', () => {
      const log = sink()
      reportHttpError({ ...report(400), url: `/${'a'.repeat(10_000)}` }, log)
      expect(String(log.warn.mock.calls[0]![0]).length).toBeLessThan(1_000)
    })

    it('keeps ordinary URLs completely readable', () => {
      const log = sink()
      reportHttpError({ ...report(404), url: '/plans/pro?expand=features' }, log)
      expect(String(log.warn.mock.calls[0]![0])).toContain('/plans/pro?expand=features')
    })
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
