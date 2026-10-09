import type { BasaltRoute, HttpReply } from './route.js'

/**
 * Headers `meta.responseHeaders` may not set: the adapter owns the framing
 * (`content-length`, `transfer-encoding`, hop-by-hop headers), the payload
 * decides its `content-type`, a cookie is per response rather than per route,
 * and `x-request-id` is the request's trace id.
 */
export const ROUTE_HEADERS_DENYLIST: ReadonlySet<string> = new Set([
  'set-cookie',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'trailer',
  'x-request-id',
])

/** RFC 9110 field-name token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Visible ASCII, space, tab and obs-text — no CR, LF, NUL or other controls. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/** The route-meta key holding a route's static response headers. */
export const RESPONSE_HEADERS_META_KEY = 'responseHeaders'

/**
 * What is wrong with a route's `meta.responseHeaders`, or `[]`. Checked at
 * boot by every adapter (through `assertRoutesGuarded`, which warns) and at
 * request time by {@link applyRouteHeaders} (which then sets none of them).
 */
export function routeHeadersProblems(route: BasaltRoute): string[] {
  const headers = route.meta?.[RESPONSE_HEADERS_META_KEY]
  if (headers === undefined) return []
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    return ['meta.responseHeaders must be an object of header name → string value']
  }
  const problems: string[] = []
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name)) problems.push(`meta.responseHeaders: ${JSON.stringify(name)} is not a valid header name`)
    else if (ROUTE_HEADERS_DENYLIST.has(name.toLowerCase())) {
      problems.push(`meta.responseHeaders: "${name}" cannot be set per route (it is managed by the adapter or the response)`)
    } else if (typeof value !== 'string') problems.push(`meta.responseHeaders["${name}"] must be a string`)
    else if (!HEADER_VALUE.test(value)) {
      problems.push(`meta.responseHeaders["${name}"] contains a control character (CR, LF, NUL…)`)
    }
  }
  return problems
}

/**
 * An invalid `meta.responseHeaders`. Not thrown in this major: an invalid
 * record warns at boot and is ignored whole. From the next major the boot
 * refuses it and a bespoke `runRoute` driver gets this error (500).
 */
export class InvalidRouteHeadersError extends Error {
  readonly code = 'HTTP_INVALID_ROUTE_HEADERS'
  readonly status = 500
  constructor(route: BasaltRoute, problems: readonly string[]) {
    super(`${route.method} ${route.url}: ${problems.join('; ')}`)
    this.name = 'InvalidRouteHeadersError'
  }
}

const NO_HEADERS: readonly (readonly [string, string])[] = []
const resolved = new WeakMap<BasaltRoute, readonly (readonly [string, string])[]>()

/**
 * Sets the route's static `meta.responseHeaders` on the reply. Called by the
 * pipeline as soon as the route is matched — before enrichers and guards — so
 * the headers are on every response the route produces: success, a guard's
 * `401`/`403`, a validation `400`, or a thrown `500`. A handler can still
 * override any of them with `reply.header()`.
 *
 * A record with any problem (a CRLF value, a denylisted or malformed name, a
 * non-string value) is ignored WHOLE — none of its headers, valid siblings
 * included, is ever sent — and never throws. The boot warns about it.
 */
export function applyRouteHeaders(route: BasaltRoute, reply: HttpReply): void {
  if (route.meta?.[RESPONSE_HEADERS_META_KEY] === undefined) return
  let pairs = resolved.get(route)
  if (!pairs) {
    pairs =
      routeHeadersProblems(route).length > 0
        ? NO_HEADERS
        : Object.entries(route.meta[RESPONSE_HEADERS_META_KEY] as Record<string, string>)
    resolved.set(route, pairs)
  }
  for (const [name, value] of pairs) reply.header(name, value)
}

/** Containers already warned about invalid `meta.responseHeaders`. */
const responseHeadersWarned = new WeakSet<object>()

/**
 * Warns once per container about routes whose `meta.responseHeaders` is
 * invalid; those records are ignored whole at request time. Never throws:
 * the next major refuses the boot instead.
 */
export function warnInvalidRouteHeaders(routes: readonly BasaltRoute[], container: object): void {
  if (responseHeadersWarned.has(container)) return
  const offenders: string[] = []
  for (const route of routes) {
    for (const problem of routeHeadersProblems(route)) offenders.push(`${route.method} ${route.url}: ${problem}`)
  }
  if (offenders.length === 0) return
  responseHeadersWarned.add(container)
  const shown = offenders.slice(0, 10).join('; ') + (offenders.length > 10 ? `; … (+${offenders.length - 10})` : '')
  console.warn(
    `[basalt] invalid meta.responseHeaders - ${shown}. These routes' meta.responseHeaders are ignored; ` +
      `this will refuse to boot in the next major.`,
  )
}
