import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineEnv, secret } from '../src/index.js'

const original = process.env['NODE_ENV']
afterEach(() => {
  if (original === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = original
})

describe('secret()', () => {
  describe('in development', () => {
    beforeEach(() => (process.env['NODE_ENV'] = 'development'))

    it('applies the devDefault when unset', () => {
      const env = defineEnv({ APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret' }) }, { source: {} })
      expect(env.APP_SECRET).toBe('dev-only-insecure-secret')
    })

    it('accepts a placeholder value (developer convenience)', () => {
      const env = defineEnv({ APP_SECRET: secret() }, { source: { APP_SECRET: 'change-me-in-production--' } })
      expect(env.APP_SECRET).toBe('change-me-in-production--')
    })
  })

  describe('in production', () => {
    beforeEach(() => (process.env['NODE_ENV'] = 'production'))

    it('requires the variable (devDefault does not apply)', () => {
      expect(() => defineEnv({ APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret' }) }, { source: {} })).toThrow(
        /APP_SECRET/,
      )
    })

    it('rejects placeholder-looking secrets', () => {
      expect(() =>
        defineEnv({ APP_SECRET: secret() }, { source: { APP_SECRET: 'change-me-in-production--' } }),
      ).toThrow(/placeholder/)
    })

    it('rejects secrets that are too short', () => {
      expect(() => defineEnv({ APP_SECRET: secret() }, { source: { APP_SECRET: 'short' } })).toThrow(/16 characters/)
    })

    it('accepts a strong, unique secret', () => {
      const strong = 'S3cure-Rnd-9f8a7b6c5d4e3f2a1b0c'
      const env = defineEnv({ APP_SECRET: secret() }, { source: { APP_SECRET: strong } })
      expect(env.APP_SECRET).toBe(strong)
    })
  })
})
