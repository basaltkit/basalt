/**
 * Making HTTP failures observable, identically on every adapter.
 *
 * Before this existed, an error's visibility depended entirely on which adapter
 * you had chosen — which is exactly the kind of difference the neutral pipeline
 * is supposed to erase:
 *
 *   - `@basaltkit/fastify` logged 5xx, and only from one of its two catch sites.
 *   - `@basaltkit/express` and `@basaltkit/hono` logged nothing at all. A 500
 *     was returned to the client and vanished from the server.
 *
 * Client errors were silent everywhere. That is defensible for a 404 from a
 * scanner and indefensible while you are trying to work out why your own
 * request came back 400 — the terminal simply stays empty.
 *
 * The POLICY lives here so all three adapters agree on it. The SINK is injected,
 * so Fastify can keep writing structured records through its own pino logger
 * while the others fall back to the console.
 */

/** What an adapter knows about a failed request, in neutral terms. */
export interface HttpErrorReport {
  error: unknown
  /** Status already resolved by `toErrorResponse`. */
  status: number
  /** Machine code from the error body, e.g. 'VALIDATION_ERROR', 'INTERNAL_ERROR'. */
  code: string
  method: string
  url: string
}

export type HttpErrorReporter = (report: HttpErrorReport) => void

/** The two levels the policy needs. `console` and a pino logger both satisfy it. */
export interface HttpLogSink {
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 5xx with the error object (stack included — it is a bug, you need the trace);
 * 4xx as a one-line warning (the stack of a validation failure is noise, the
 * code and message are the information).
 *
 * Never throws: a logging sink that fails must not turn a handled 400 into an
 * unhandled crash inside the error handler itself.
 */
export function reportHttpError(report: HttpErrorReport, sink: HttpLogSink = console): void {
  const { error, status, code, method, url } = report
  try {
    if (status >= 500) {
      sink.error(`[basalt:http] ${method} ${url} → ${status} ${code}`, error)
    } else if (status >= 400) {
      sink.warn(`[basalt:http] ${method} ${url} → ${status} ${code}: ${messageOf(error)}`)
    }
  } catch {
    // Deliberately swallowed — see above.
  }
}

/** Binds a sink, giving the adapter a plain reporter to call or to let callers override. */
export function httpErrorReporter(sink: HttpLogSink = console): HttpErrorReporter {
  return (report) => reportHttpError(report, sink)
}
