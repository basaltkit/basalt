/**
 * Structured error payloads — and the sanitiser that makes them safe to send.
 *
 * An error body used to be `{ error: { code, message } }`, so any data the UI
 * needed had to be smuggled into the message: apps ended up parsing
 * `Checks failed: A, B` to find out which checks failed. `details` gives that
 * data a place of its own.
 *
 * It is written by the server and read by the client verbatim, which makes it a
 * channel — so it is bounded on every axis before it leaves:
 *
 *  - **Plain data only.** Strings, finite numbers, booleans, `null`, arrays and
 *    plain objects. A `Date` becomes its ISO string. Everything else is dropped:
 *    functions, symbols, `undefined`, BigInt, `NaN`/`Infinity`, and every exotic
 *    object — `Error` (a stack is an internal), `Map`/`Set`/`RegExp`, typed
 *    arrays, and class instances (an ORM row would otherwise walk out through an
 *    error body). Dropping rather than rejecting keeps a serialisation slip from
 *    turning a handled 422 into a 500.
 *  - **Acyclic and shallow.** A cycle is dropped where it closes;
 *    nesting past {@link MAX_ERROR_DETAILS_DEPTH} is dropped.
 *  - **Small.** Over {@link MAX_ERROR_DETAILS_BYTES} of serialised JSON the
 *    whole payload is dropped, so an error can never become an exfiltration or
 *    amplification channel.
 *  - **Opt-in.** Only errors explicitly constructed with `details` have any. An
 *    unexpected exception still becomes the neutral 500 with nothing attached.
 */

/** A structured error payload: plain JSON data, keyed by name. */
export type ErrorDetails = Record<string, unknown>

/** Largest `details` payload sent to a client, in bytes of serialised JSON. */
export const MAX_ERROR_DETAILS_BYTES = 4_096

/** Deepest array/object nesting kept; anything below it is dropped. */
export const MAX_ERROR_DETAILS_DEPTH = 8

type Sanitized = { keep: true; value: unknown } | { keep: false }

const DROP: Sanitized = { keep: false }

/** Data, not an instance of something: `{}` or `Object.create(null)`. */
function isPlainRecord(value: unknown): value is ErrorDetails {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function sanitizeValue(value: unknown, depth: number, seen: Set<object>): Sanitized {
  if (value === null) return { keep: true, value: null }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return { keep: true, value }
    case 'number':
      // JSON has no NaN or Infinity; `JSON.stringify` would quietly write null.
      return Number.isFinite(value) ? { keep: true, value } : DROP
    case 'object':
      break
    default:
      // undefined, function, symbol, bigint.
      return DROP
  }

  const object = value as object
  if (object instanceof Date) {
    const time = object.getTime()
    return Number.isFinite(time) ? { keep: true, value: object.toISOString() } : DROP
  }
  const isArray = Array.isArray(object)
  if (!isArray && !isPlainRecord(object)) return DROP
  if (seen.has(object)) return DROP
  if (depth >= MAX_ERROR_DETAILS_DEPTH) return DROP

  seen.add(object)
  try {
    if (isArray) {
      // A dropped element becomes null rather than shifting every later index —
      // the same rule `JSON.stringify` applies to a function inside an array.
      const items = (object as unknown[]).map((item) => {
        const sanitized = sanitizeValue(item, depth + 1, seen)
        return sanitized.keep ? sanitized.value : null
      })
      return { keep: true, value: items }
    }
    return { keep: true, value: sanitizeRecord(object as ErrorDetails, depth + 1, seen) }
  } finally {
    seen.delete(object)
  }
}

function sanitizeRecord(record: ErrorDetails, depth: number, seen: Set<object>): ErrorDetails {
  const clean: ErrorDetails = {}
  for (const [key, value] of Object.entries(record)) {
    // Assigning this key on a normal object hits Object.prototype's setter —
    // prototype pollution, from an error body.
    if (key === '__proto__') continue
    const sanitized = sanitizeValue(value, depth, seen)
    if (sanitized.keep) clean[key] = sanitized.value
  }
  return clean
}

/**
 * Makes a client-safe copy of a structured error payload, or returns
 * `undefined` when there is nothing safe to send (see the rules at the top of
 * this module). Never throws, and never returns the caller's own object.
 */
export function sanitizeErrorDetails(details: unknown): ErrorDetails | undefined {
  if (!isPlainRecord(details)) return undefined
  try {
    const clean = sanitizeRecord(details, 1, new Set<object>([details]))
    if (Object.keys(clean).length === 0) return undefined
    const json = JSON.stringify(clean)
    if (typeof json !== 'string') return undefined
    if (new TextEncoder().encode(json).length > MAX_ERROR_DETAILS_BYTES) return undefined
    return clean
  } catch {
    // A throwing getter or an exotic proxy: an error body is never worth a
    // second error, so the payload is simply not sent.
    return undefined
  }
}
