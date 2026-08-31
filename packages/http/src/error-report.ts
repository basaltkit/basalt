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

/**
 * `(fields, message)` — pino's own signature, and the reason this is the shape.
 *
 * Request data goes in `fields`, NEVER in `message`. `message` is always a
 * string literal from this module, which removes format-string injection as a
 * category rather than mitigating it: neither `console` nor pino can interpret
 * a `%s` that never reaches the format position. It also removes log forging,
 * since a value inside a structured field is JSON-encoded by pino and quoted by
 * `util.inspect` on the console — a newline cannot end the line.
 *
 * An earlier version composed one interpolated string and escaped it by hand.
 * That was correct and tested, but static analysis cannot see a custom
 * sanitiser, so the alert never cleared; and passing the error as a trailing
 * argument to a printf-style call is worse than it looks — pino silently DROPS
 * arguments beyond the placeholders, so the stack we log a 5xx for would have
 * been thrown away.
 */
export interface HttpLogSink {
  error(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
}

/**
 * `console` adapted to the contract above.
 *
 * The argument order is flipped deliberately: pino wants the object first, the
 * console reads far better with the message first and the detail after. Both
 * keep a string literal in the format position.
 */
export const consoleSink: HttpLogSink = {
  error: (fields, message) => console.error(message, fields),
  warn: (fields, message) => console.warn(message, fields),
}

const FAILED = '[basalt:http] request failed'
const REJECTED = '[basalt:http] request rejected'

/** Longest a URL may be before it is cut — one huge request should not flood the log. */
const MAX_URL = 1_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 5xx to `error` with the error object (the stack is the point — it is a bug);
 * 4xx to `warn` with its code and reason (a validation failure's stack is noise).
 *
 * Never throws: a logging sink that fails must not turn a handled 400 into an
 * unhandled crash inside the error handler itself.
 */
export function reportHttpError(report: HttpErrorReport, sink: HttpLogSink = consoleSink): void {
  const { error, status, code, method, url } = report
  try {
    const fields = {
      method,
      url: String(url).slice(0, MAX_URL),
      // Coerced rather than trusted: `HttpErrorReport` is a plain object an
      // adapter could fill in wrongly.
      status: Number(status),
      code,
    }
    if (status >= 500) {
      // `err` is pino's conventional key for a serialisable error.
      sink.error({ ...fields, err: error }, FAILED)
    } else if (status >= 400) {
      sink.warn({ ...fields, reason: messageOf(error) }, REJECTED)
    }
  } catch {
    // Deliberately swallowed — see above.
  }
}

/** Binds a sink, giving the adapter a plain reporter to call or to let callers override. */
export function httpErrorReporter(sink: HttpLogSink = consoleSink): HttpErrorReporter {
  return (report) => reportHttpError(report, sink)
}
