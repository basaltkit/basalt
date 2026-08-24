import { createHash } from 'node:crypto'

/**
 * Conditional GETs via ETags. Opt a route in with `meta: { etag: true }`: the
 * pipeline hashes the response body into a strong `ETag`, and when the client's
 * `If-None-Match` matches it replies `304 Not Modified` with no body — saving
 * bandwidth without the handler doing anything. Adapter-agnostic (it runs in the
 * shared `runRoute` pipeline).
 */

/** A strong ETag for a serialized body: quoted sha1 (base64url). */
export function computeEtag(body: string): string {
  return `"${createHash('sha1').update(body).digest('base64url')}"`
}

const stripWeak = (tag: string): string => tag.trim().replace(/^W\//, '')

/** Whether an `If-None-Match` header (`*`, or a comma-separated list) matches `etag`. */
export function ifNoneMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  const target = stripWeak(etag)
  return header.split(',').some((candidate) => stripWeak(candidate) === target)
}
