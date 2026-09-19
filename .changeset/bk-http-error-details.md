---
'@basaltkit/core': minor
'@basaltkit/http': minor
'@basaltkit/sdk': minor
---

Structured error details — a machine-readable payload on HTTP errors (BK-021).

An error body was `{ error: { code, message } }`, so any data the UI had to act on (which checks failed, how much quota is left, the conflicting field, the current version behind a 409) had to be smuggled into the human-readable message — apps ended up parsing `Checks failed: A, B`.

- **http** — `new HttpError(status, code, message, options?)` takes `HttpErrorOptions` = `{ details?: Record<string, unknown>; cause?: unknown }`. An options object rather than a fourth positional argument, so later additions do not keep widening the signature; the three-argument form is unchanged and adds no `details` key. `toErrorResponse` serializes a sanitised copy as `error.details`, so **fastify, express and hono serve the identical body** (covered by a new `errorDetailsParitySuite` the three adapter packages run).
- **core** — `BasaltError`'s third argument is now `BasaltErrorOptions` (`ErrorOptions` + `details`), and instances expose `error.details`. Domain packages that throw a `BasaltError` with a numeric `status` (auth, permissions, files, …) can therefore carry details too, and the HTTP serializer picks them up from both. Core never sanitises: it keeps the object exactly as given.
- **Security rules (documented in the http README, `@basaltkit/core`'s Errors section and the Core concepts guide).** `details` reaches the client verbatim, so the neutral serializer bounds it via the exported `sanitizeErrorDetails` (+ `MAX_ERROR_DETAILS_BYTES` = 4096, `MAX_ERROR_DETAILS_DEPTH` = 8): plain JSON data only (a `Date` becomes its ISO string); functions, symbols, `undefined`, BigInt, `NaN`/`Infinity`, `Error`s, `Map`/`Set`/`RegExp`, typed arrays and class instances are stripped rather than rejected (a serialisation slip must not turn a handled 422 into a 500); a dropped array element becomes `null`; a `__proto__` key is never copied; cycles and nesting past the depth cap are dropped; and a payload over 4 KiB of serialised JSON is dropped **whole**, so an error can never become an exfiltration or amplification channel. Only errors explicitly constructed with `details` ever have any — an unexpected exception is still the neutral `500 INTERNAL_ERROR` with nothing attached, and a framework-raised 4xx never grows one. Never put secrets or internals in it.
- The `RequestValidationError` body is untouched: still exactly `{ code, message, part, issues }`, with no `details` key.
- **sdk** — `BasaltClientError.errorDetails` returns the server's `error.details` (or `undefined`), instead of making callers dig through `error.details.error.details`; new exported `BasaltErrorBody` type for the full body shape.
