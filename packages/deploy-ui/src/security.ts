/**
 * The checks every request passes before routing (RFC 0009 §4.3), and the
 * headers every response carries (§4.4). Pure: a request's method, path and
 * headers in, a verdict out.
 *
 * The UI's server is reachable by every process on the machine and is the
 * target of every page the browser opens: exact `Host` (DNS rebinding), a
 * POST-only JSON API with an exact `Origin` (CSRF, cross-origin fetch), a
 * bearer token no other page can read, and no CORS, ever.
 */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=()',
}

export const MAX_BODY_BYTES = 1024 * 1024

/** A static file's name under /client/: flat, lowercase, `.js` — never a path. */
export const CLIENT_FILE = /^[a-z0-9-]+\.js$/

export interface RequestFacts {
  method: string
  /** The raw request target (`req.url`). */
  url: string
  headers: Record<string, string | string[] | undefined>
}

export type Verdict =
  | { kind: 'static'; file: 'index' | 'css' | { client: string } }
  | { kind: 'api'; route: string }
  | { kind: 'refuse'; status: number; reason: string }

const header = (facts: RequestFacts, name: string): string | undefined => {
  const value = facts.headers[name]
  return Array.isArray(value) ? undefined : value
}

/**
 * Host, method, path, content type, origin and fetch metadata. The token is
 * checked by the caller (it needs the session), after this verdict.
 */
export function checkRequest(facts: RequestFacts, port: number): Verdict {
  const origin = `http://127.0.0.1:${port}`
  if (header(facts, 'host') !== `127.0.0.1:${port}`) return { kind: 'refuse', status: 421, reason: 'wrong Host' }
  // The request target is a path, nothing else: no absolute form, no query, no encoded or dot segment.
  const path = facts.url
  if (!/^\/[A-Za-z0-9/._-]*$/.test(path) || path.includes('//') || path.split('/').some((s) => s === '.' || s === '..')) {
    return { kind: 'refuse', status: 404, reason: 'not found' }
  }
  if (!path.startsWith('/api/')) {
    if (facts.method !== 'GET' && facts.method !== 'HEAD') return { kind: 'refuse', status: 405, reason: 'method not allowed' }
    if (path === '/') return { kind: 'static', file: 'index' }
    if (path === '/app.css') return { kind: 'static', file: 'css' }
    const name = path.startsWith('/client/') ? path.slice('/client/'.length) : ''
    if (CLIENT_FILE.test(name)) return { kind: 'static', file: { client: name } }
    return { kind: 'refuse', status: 404, reason: 'not found' }
  }
  if (facts.method !== 'POST') return { kind: 'refuse', status: 405, reason: 'POST only' }
  const type = header(facts, 'content-type')
  if (!type || !/^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i.test(type)) return { kind: 'refuse', status: 415, reason: 'application/json only' }
  if (header(facts, 'origin') !== origin) return { kind: 'refuse', status: 403, reason: 'wrong Origin' }
  const site = header(facts, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin') return { kind: 'refuse', status: 403, reason: 'cross-site request' }
  return { kind: 'api', route: path.slice('/api/'.length) }
}
