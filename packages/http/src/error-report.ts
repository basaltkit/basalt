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

/** Longest a single interpolated value may be before it is cut. */
const MAX_FIELD = 200

/**
 * Unicode's "Other, control" category — C0, C1 and DEL, i.e. everything that can
 * break a log line apart. `\p{Cc}` rather than a hand-written character range:
 * it says what it means, and a literal range of control characters is both
 * unreadable in review and easy to get subtly wrong.
 */
const CONTROL_CHARACTERS = /\p{Cc}/gu

/** Any `%`, so the composed line can never be read as a printf format specifier. */
const PERCENT = /%/g

/**
 * Neutralises a value before it is interpolated into a log line.
 *
 * Everything interpolated here — method, URL, and an error message that often
 * quotes the request — is attacker-controlled, and two real problems follow:
 *
 *  - **Log forging.** A newline in the URL ends the line and starts another, so
 *    a request can write whatever it likes into the log, including a convincing
 *    fake entry attributed to some other request.
 *  - **Format-string injection.** Both `console` and pino treat the first
 *    argument as a printf-style format string. A URL containing `%s` would make
 *    the logger consume the NEXT argument — which, for a 5xx, is the error
 *    object itself — as a substitution, corrupting the record and swallowing
 *    the stack we logged it for.
 *
 * Control characters become spaces, `%` is doubled, and the result is capped so
 * a single enormous URL cannot flood the log. Ordinary URLs pass through intact.
 */
function safe(value: unknown, max = MAX_FIELD): string {
  const text = String(value).replace(CONTROL_CHARACTERS, ' ').replace(PERCENT, '%%')
  return text.length > max ? `${text.slice(0, max)}…` : text
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
    // Every interpolated field is sanitised, because they all originate in the
    // request. `status` is the one value the framework itself produced, and it
    // is still coerced rather than trusted — `HttpErrorReport` is a plain object
    // that an adapter could fill in wrongly.
    const line = `[basalt:http] ${safe(method, 16)} ${safe(url)} → ${Number(status)} ${safe(code, 64)}`
    if (status >= 500) {
      sink.error(line, error)
    } else if (status >= 400) {
      sink.warn(`${line}: ${safe(messageOf(error), 500)}`)
    }
  } catch {
    // Deliberately swallowed — see above.
  }
}

/** Binds a sink, giving the adapter a plain reporter to call or to let callers override. */
export function httpErrorReporter(sink: HttpLogSink = console): HttpErrorReporter {
  return (report) => reportHttpError(report, sink)
}
