import type { BasaltRoute, HttpReply } from './route.js'

/**
 * Headers `meta.headers` may not set: the adapter owns the framing
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

/**
 * What is wrong with a route's `meta.headers`, or `[]`. Run at boot by every
 * adapter (through `assertRoutesGuarded` → `assertRouteMetaValid`).
 */
export function routeHeadersProblems(route: BasaltRoute): string[] {
  const headers = route.meta?.['headers']
  if (headers === undefined) return []
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
    return ['meta.headers must be an object of header name → string value']
  }
  const problems: string[] = []
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (!HEADER_NAME.test(name)) problems.push(`meta.headers: ${JSON.stringify(name)} is not a valid header name`)
    else if (ROUTE_HEADERS_DENYLIST.has(name.toLowerCase())) {
      problems.push(`meta.headers: "${name}" cannot be set per route (it is managed by the adapter or the response)`)
    } else if (typeof value !== 'string') problems.push(`meta.headers["${name}"] must be a string`)
    else if (!HEADER_VALUE.test(value)) problems.push(`meta.headers["${name}"] contains a control character (CR, LF, NUL…)`)
  }
  return problems
}

/** Thrown at request time for `meta.headers` that never went through the boot check (a bespoke `runRoute` driver). */
export class InvalidRouteHeadersError extends Error {
  readonly code = 'HTTP_INVALID_ROUTE_HEADERS'
  readonly status = 500
  constructor(route: BasaltRoute, problems: readonly string[]) {
    super(`${route.method} ${route.url}: ${problems.join('; ')}`)
    this.name = 'InvalidRouteHeadersError'
  }
}

const resolved = new WeakMap<BasaltRoute, readonly (readonly [string, string])[]>()

/**
 * Sets the route's static `meta.headers` on the reply. Called by the pipeline
 * as soon as the route is matched — before enrichers and guards — so the
 * headers are on every response the route produces: success, a guard's
 * `401`/`403`, a validation `400`, or a thrown `500`. A handler can still
 * override any of them with `reply.header()`.
 */
export function applyRouteHeaders(route: BasaltRoute, reply: HttpReply): void {
  if (route.meta?.['headers'] === undefined) return
  let pairs = resolved.get(route)
  if (!pairs) {
    const problems = routeHeadersProblems(route)
    if (problems.length > 0) throw new InvalidRouteHeadersError(route, problems)
    pairs = Object.entries(route.meta['headers'] as Record<string, string>)
    resolved.set(route, pairs)
  }
  for (const [name, value] of pairs) reply.header(name, value)
}
