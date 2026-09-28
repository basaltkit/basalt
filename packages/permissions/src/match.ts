/**
 * The permission-matching rule, on its own and with no dependencies.
 *
 * A separate file with a separate export path because the rule is needed in
 * **two** places: the server, where it decides, and the browser, where it hides
 * a button that would only return 403.
 *
 * `@basaltkit/permissions` cannot be imported from a browser — it depends on
 * `@basaltkit/core`, which imports `node:async_hooks` and `node:crypto`. So
 * every frontend rewrote the rule, and the rewrites drifted: one seen in the
 * wild handled `resource:*` and missed the global `'*'`, silently hiding
 * controls from the people allowed to use them.
 *
 * ```ts
 * import { permissionMatches } from '@basaltkit/permissions/match'
 * ```
 *
 * Nothing may be added to this file that imports anything. That is the whole
 * point of it.
 */

/**
 * `'projects:*'` grants `'projects:delete'`; `'*'` grants everything.
 *
 * A permission with an empty segment (`''`, `'projects:'`, `':read'`,
 * `'a::b'`) is malformed and never matches anything — not even itself, and
 * not a wildcard: `'projects:*'` does not grant `'projects:'`, and `'*'` does
 * not grant `''`.
 */
export function permissionMatches(granted: string, requested: string): boolean {
  if (typeof granted !== 'string' || typeof requested !== 'string') return false
  const requestedParts = requested.split(':')
  if (requestedParts.includes('')) return false
  if (granted === '*') return true
  const grantedParts = granted.split(':')
  if (grantedParts.includes('')) return false
  if (grantedParts.length !== requestedParts.length) return false
  return grantedParts.every((part, index) => part === '*' || part === requestedParts[index])
}

/** True when `permission` has no empty segment (`''`, `'a:'`, `':b'`, `'a::b'` do). */
export function hasEmptySegment(permission: string): boolean {
  return permission.split(':').includes('')
}

/** True when any granted permission covers `requested`. */
export function permitted(granted: readonly string[], requested: string): boolean {
  return granted.some((g) => permissionMatches(g, requested))
}
