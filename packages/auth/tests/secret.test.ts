import { afterEach, describe, expect, it } from 'vitest'
import { Auth, MemoryUserSource, WeakJwtSecretError } from '../src/index.js'

const mk = (secret: string) => () => new Auth({ users: new MemoryUserSource(), secret })

describe('JWT secret strength (H-1)', () => {
  const original = process.env['NODE_ENV']
  afterEach(() => {
    process.env['NODE_ENV'] = original
  })

  it('always rejects an empty secret', () => {
    expect(mk('')).toThrow(WeakJwtSecretError)
  })

  it('rejects a short secret in production, accepts a strong one', () => {
    process.env['NODE_ENV'] = 'production'
    expect(mk('short-secret')).toThrow(WeakJwtSecretError)
    expect(mk('x'.repeat(32))).not.toThrow()
  })

  it('allows a short (non-empty) secret outside production for dev convenience', () => {
    process.env['NODE_ENV'] = 'development'
    expect(mk('dev-secret')).not.toThrow()
  })
})
