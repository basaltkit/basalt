import { describe, expect, it, vi } from 'vitest'
import { consoleSink, httpErrorReporter, reportHttpError } from '../src/error-report.js'

/**
 * The POLICY every adapter shares. Which statuses are reported, and at which
 * level, is decided here exactly once — the adapters only choose where the
 * records go. Their own suites assert that they call this; this one asserts
 * what it does.
 */

const sink = () => ({
  error: vi.fn<(fields: Record<string, unknown>, message: string) => void>(),
  warn: vi.fn<(fields: Record<string, unknown>, message: string) => void>(),
})

const report = (status: number, error: unknown = new Error('boom')) => ({
  error,
  status,
  code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR',
  method: 'POST',
  url: '/plans',
})

describe('HTTP error reporting policy', () => {
  it('sends 5xx to error, carrying the error object so the stack survives', () => {
    const log = sink()
    const boom = new Error('boom')
    reportHttpError(report(500, boom), log)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.warn).not.toHaveBeenCalled()

    const [fields, message] = log.error.mock.calls[0]!
    expect(fields).toMatchObject({ method: 'POST', url: '/plans', status: 500, code: 'INTERNAL_ERROR' })
    // `err` is pino's conventional key, so its serialiser renders the stack.
    expect(fields['err']).toBe(boom)
    expect(message).toBe('[basalt:http] request failed')
  })

  it('sends 4xx to warn, with the reason but not the stack', () => {
    const log = sink()
    reportHttpError(report(400, new Error('body.price: expected number')), log)
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.error).not.toHaveBeenCalled()

    const [fields, message] = log.warn.mock.calls[0]!
    expect(fields).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' })
    expect(fields['reason']).toBe('body.price: expected number')
    // A validation failure's stack is noise, so it is deliberately absent.
    expect(fields['err']).toBeUndefined()
    expect(message).toBe('[basalt:http] request rejected')
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
    const exploding = {
      error() { throw new Error('transport down') },
      warn() { throw new Error('transport down') },
    }
    expect(() => reportHttpError(report(500), exploding)).not.toThrow()
    expect(() => reportHttpError(report(400), exploding)).not.toThrow()
  })

  it('renders a non-Error throw without blowing up', () => {
    const log = sink()
    reportHttpError({ ...report(400), error: 'just a string' }, log)
    expect(log.warn.mock.calls[0]![0]['reason']).toBe('just a string')
  })

  /**
   * CodeQL reported js/tainted-format-string and js/log-injection against an
   * earlier version that composed one interpolated string and escaped it by
   * hand. That was correct and tested, but a sanitiser static analysis cannot
   * see is worth less than a shape that removes the risk outright.
   *
   * The shape is now `(fields, message)` with `message` always a literal from
   * the module. These tests pin that down, because a future edit that slips a
   * value into the message would silently reopen both classes.
   */
  describe('request data never reaches the format position', () => {
    const MESSAGES = ['[basalt:http] request failed', '[basalt:http] request rejected']

    it('keeps the message a constant even for a hostile URL', () => {
      const log = sink()
      const hostile = '/x?q=%s%d%j%o\nWARN forged line'
      reportHttpError({ ...report(500), url: hostile }, log)
      reportHttpError({ ...report(400), url: hostile }, log)

      expect(MESSAGES).toContain(log.error.mock.calls[0]![1])
      expect(MESSAGES).toContain(log.warn.mock.calls[0]![1])
      // The URL is preserved verbatim as DATA — the sink escapes it when it
      // serialises (pino as JSON, console via util.inspect), so nothing has to
      // be mangled to be safe.
      expect(log.error.mock.calls[0]![0]['url']).toBe(hostile)
    })

    it('passes exactly two arguments, so nothing can be read as a substitution', () => {
      const log = sink()
      reportHttpError(report(500), log)
      expect(log.error.mock.calls[0]).toHaveLength(2)
      reportHttpError(report(400), log)
      expect(log.warn.mock.calls[0]).toHaveLength(2)
    })

    it('caps a huge URL instead of flooding the log', () => {
      const log = sink()
      reportHttpError({ ...report(400), url: `/${'a'.repeat(10_000)}` }, log)
      expect(String(log.warn.mock.calls[0]![0]['url']).length).toBeLessThanOrEqual(1_000)
    })

    it('coerces a status the adapter filled in wrongly', () => {
      const log = sink()
      reportHttpError({ ...report(500), status: '500' as unknown as number }, log)
      expect(log.error.mock.calls[0]![0]['status']).toBe(500)
    })
  })

  it('consoleSink puts the message first, where the console reads best', () => {
    // pino wants the object first; the console reads far better the other way
    // round. Both keep a string literal in the format position.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      consoleSink.error({ url: '/x' }, '[basalt:http] request failed')
      expect(spy).toHaveBeenCalledWith('[basalt:http] request failed', { url: '/x' })
    } finally {
      spy.mockRestore()
    }
  })

  it('httpErrorReporter binds a sink and defaults to the console', () => {
    const log = sink()
    httpErrorReporter(log)(report(500))
    expect(log.error).toHaveBeenCalledTimes(1)

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      httpErrorReporter()(report(404))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0]![0]).toBe('[basalt:http] request rejected')
    } finally {
      spy.mockRestore()
    }
  })
})
