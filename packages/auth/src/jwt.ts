import { createHmac, timingSafeEqual } from 'node:crypto'
import { BasaltError, parseDuration, type DurationInput } from '@basaltkit/core'

export class TokenInvalidError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_TOKEN_INVALID', 'The token is invalid.')
  }
}

export class TokenExpiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_TOKEN_EXPIRED', 'The token has expired.')
  }
}

export interface JwtClaims {
  sub: string
  iat: number
  exp?: number
  /** Access-token version — checked against TokenVersionStore for revocation. */
  tv?: number
  /**
   * Authentication methods used at sign-in (RFC 8176 style): `pwd` (password),
   * `fed` (social / SSO provider), `mfa` (a second factor was verified).
   */
  amr?: string[]
  [claim: string]: unknown
}

/** One unpadded base64url segment — nothing outside the alphabet, no `=`. */
const SEGMENT = /^[A-Za-z0-9_-]+$/

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/** Signs a compact HS256 JWT — no dependencies, node:crypto only. */
export function signJwt(
  claims: Record<string, unknown> & { sub: string },
  options: { secret: string; expiresIn?: DurationInput },
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtClaims = {
    iat: now,
    ...(options.expiresIn !== undefined
      ? { exp: now + Math.ceil(parseDuration(options.expiresIn) / 1000) }
      : {}),
    ...claims,
  }
  const head = encode({ alg: 'HS256', typ: 'JWT' })
  const body = encode(payload)
  const signature = createHmac('sha256', options.secret)
    .update(`${head}.${body}`)
    .digest('base64url')
  return `${head}.${body}.${signature}`
}

/** Verifies signature and expiry; returns the claims. */
export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new TokenInvalidError()
  const [head, body, signature] = parts as [string, string, string]
  // Node's base64url decoder silently skips characters outside the alphabet
  // and ignores the unused low bits of the last character, so without these
  // checks `token + '!!!'` (or a tweaked final char) would still verify —
  // token strings would be malleable, defeating denylists or idempotency keyed
  // on the exact token. Only the canonical encoding is accepted.
  if (!SEGMENT.test(head) || !SEGMENT.test(body) || !SEGMENT.test(signature)) {
    throw new TokenInvalidError()
  }

  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest()
  const received = Buffer.from(signature, 'base64url')
  if (
    received.toString('base64url') !== signature ||
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  ) {
    throw new TokenInvalidError()
  }

  let claims: JwtClaims
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtClaims
  } catch {
    throw new TokenInvalidError()
  }
  if (typeof claims.sub !== 'string') throw new TokenInvalidError()
  if (claims.exp !== undefined && claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new TokenExpiredError()
  }
  return claims
}
