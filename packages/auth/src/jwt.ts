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
  [claim: string]: unknown
}

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

  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest()
  const received = Buffer.from(signature, 'base64url')
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
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
