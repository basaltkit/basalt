import { describe, expect, it } from 'vitest'
import { BasaltError } from '../src/index.js'

describe('BasaltError', () => {
  it('keeps code, name and the standard cause', () => {
    class DomainError extends BasaltError {}
    const cause = new Error('root')
    const error = new DomainError('DOMAIN_FAILED', 'It failed.', { cause })
    expect(error.code).toBe('DOMAIN_FAILED')
    expect(error.name).toBe('DomainError')
    expect(error.cause).toBe(cause)
    expect(error.details).toBeUndefined()
  })

  it('carries an optional structured payload for the HTTP layer to serialize (BK-021)', () => {
    const details = { limit: 100, used: 100 }
    const error = new BasaltError('QUOTA_EXCEEDED', 'Plan quota exceeded.', { details })
    expect(error.details).toBe(details)
  })
})
