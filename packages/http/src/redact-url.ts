/**
 * Query strings carry secrets far more often than they should: OAuth `code` and
 * `state`, magic-link and reset tokens, signed-URL signatures, `?api_key=`. A log
 * line or a trace span is the wrong place for any of them — both are shipped,
 * retained and read by many more people than the request itself.
 */

/** Placeholder for a masked query value. */
export const REDACTED = '[REDACTED]'

// A parameter name is kept only when it looks like a name. Anything else — a
// blob or anything encoded — is masked like a value.
const NAME = /^[A-Za-z0-9_.\-[\]]{1,64}$/
const name = (raw: string): string => (NAME.test(raw) ? raw : REDACTED)

/**
 * Keeps the path and the parameter NAMES (useful for debugging) and replaces
 * every query VALUE with {@link REDACTED}. The fragment is dropped. Works on a
 * path (`/a?b=c`) and on an absolute URL (`https://h/a?b=c`) alike, and never
 * decodes anything — whatever follows the first `=` of a pair is masked, however
 * it is encoded; a valueless entry (a bare `?<token>`) and a name that does
 * not look like one are masked as well.
 */
export function redactUrl(url: string): string {
  const text = String(url)
  const hash = text.indexOf('#')
  const withoutFragment = hash === -1 ? text : text.slice(0, hash)
  const question = withoutFragment.indexOf('?')
  if (question === -1) return withoutFragment
  const path = withoutFragment.slice(0, question)
  const query = withoutFragment.slice(question + 1)
  if (query === '') return path
  const masked = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      // A valueless entry is as likely a bare token (`/magic?<token>`) as a
      // flag name, and a token can look exactly like a name: mask it.
      if (eq === -1) return pair === '' ? pair : REDACTED
      return `${name(pair.slice(0, eq))}=${REDACTED}`
    })
    .join('&')
  return `${path}?${masked}`
}

/** The path alone — no query, no fragment. */
export function urlPath(url: string): string {
  const text = String(url)
  const end = text.search(/[?#]/)
  return end === -1 ? text : text.slice(0, end)
}
