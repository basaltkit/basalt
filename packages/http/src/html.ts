import { createHash } from 'node:crypto'

/**
 * Primitives for server-rendered HTML pages (the `*-ui` packages and any app
 * route that returns HTML). Three footguns, one shared answer each:
 *
 * - {@link escapeHtml} — one escaping charset (`& < > " '`) that is safe in
 *   text nodes AND inside single- or double-quoted attributes, so pages don't
 *   grow divergent hand-rolled `esc()` helpers with attribute-breakout gaps.
 * - {@link scriptJson} — `JSON.stringify` output is NOT safe inside a
 *   `<script>` block: a string containing `</script>` terminates the element
 *   (JSON does not escape `/`). This escapes `<` so embedded state can't break
 *   out, plus U+2028/U+2029 which are valid JSON but illegal in JS strings.
 * - {@link pageCsp} — a route-scoped Content-Security-Policy for a
 *   self-contained page, hashing its inline `<script>` blocks so the page works
 *   under `securityPlugin` without the operator disabling CSP app-wide.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes `& < > " '` — safe for text nodes and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string)
}

/**
 * `JSON.stringify` a value so it can be embedded inside an inline `<script>`
 * element without a crafted string (`"</script><svg onload=…>"`) terminating
 * the block early.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export interface PageCspOptions {
  /** The exact source text of each inline `<script>` block (hashed with sha256). */
  scripts?: string[]
  /** Extra `connect-src` origins beyond `'self'` (e.g. an absolute `apiBase`). */
  connect?: string[]
}

/** sha256 CSP source expression for one inline script/style block. */
export function cspHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`
}

/**
 * A locked-down, route-scoped CSP for a self-contained HTML page: everything
 * denied by default; inline scripts allowed ONLY by hash; styles inline
 * (`style-src 'unsafe-inline'` — hash sources cannot cover `style=""`
 * attributes); fetch restricted to `'self'` plus the given origins. Set it on
 * the route's response so it overrides the app-wide default from
 * `securityPlugin` for that page only.
 */
export function pageCsp(options: PageCspOptions = {}): string {
  const scriptSrc = (options.scripts ?? []).map(cspHash)
  const connectSrc = ["'self'", ...(options.connect ?? [])]
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "style-src 'unsafe-inline'",
    scriptSrc.length > 0 ? `script-src ${scriptSrc.join(' ')}` : "script-src 'none'",
    `connect-src ${connectSrc.join(' ')}`,
  ].join('; ')
}
