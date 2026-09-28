/**
 * Request media-type helpers every adapter uses to decide how a body is parsed,
 * so the same `Content-Type` means the same thing on Fastify, Express and Hono.
 */

/**
 * Default maximum size, in bytes, of a request body an adapter buffers and
 * parses (1 MiB) — Fastify's own default, and the one the Express and Hono
 * adapters apply unless told otherwise. `upload()` and `rawBody()` routes carry
 * their own limits.
 */
export const DEFAULT_BODY_LIMIT = 1_048_576

/**
 * The media type of a `Content-Type` header — lower-cased, parameters and
 * surrounding whitespace removed. `''` when the header is absent.
 */
export function mediaTypeOf(header: string | readonly string[] | null | undefined): string {
  const value = Array.isArray(header) ? header[0] : (header as string | null | undefined)
  if (typeof value !== 'string') return ''
  const cut = value.indexOf(';')
  return (cut < 0 ? value : value.slice(0, cut)).trim().toLowerCase()
}

/** `type/subtype` token characters (RFC 9110 `token`). */
const JSON_SUFFIX = /^application\/[a-z0-9!#$&^_.+-]+\+json$/

/**
 * True when a `Content-Type` announces JSON: exactly `application/json`, or a
 * structured-syntax `+json` type (`application/merge-patch+json`,
 * `application/vnd.api+json`), parameters ignored.
 *
 * A substring test is NOT enough: `text/plain; application/json` is a
 * CORS-safelisted type a cross-site form or `fetch` can send without a
 * preflight, and parsing it as JSON would hand a JSON route a cross-origin
 * request the browser never asked permission for.
 */
export function isJsonMediaType(header: string | readonly string[] | null | undefined): boolean {
  const type = mediaTypeOf(header)
  return type === 'application/json' || JSON_SUFFIX.test(type)
}
