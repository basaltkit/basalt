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

describe('secret() — fail-closed unless NODE_ENV explicitly opts into dev (security)', () => {
  it('requires the variable when NODE_ENV is unset (devDefault never applies)', () => {
    delete process.env['NODE_ENV']
    expect(() =>
      defineEnv({ APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-please-change-me' }) }, { source: {} }),
    ).toThrow(/APP_SECRET/)
  })

  it('requires the variable for any NODE_ENV other than development/test', () => {
    for (const value of ['staging', 'prod', 'Production', '']) {
      process.env['NODE_ENV'] = value
      expect(() => defineEnv({ APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret' }) }, { source: {} })).toThrow(
        /APP_SECRET/,
      )
    }
  })

  it('rejects placeholder-looking secrets when NODE_ENV is unset', () => {
    delete process.env['NODE_ENV']
    expect(() =>
      defineEnv({ APP_SECRET: secret() }, { source: { APP_SECRET: 'dev-only-insecure-secret-please-change-me' } }),
    ).toThrow(/placeholder/)
  })

  it('still applies the devDefault under NODE_ENV=test', () => {
    process.env['NODE_ENV'] = 'test'
    const env = defineEnv({ APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret' }) }, { source: {} })
    expect(env.APP_SECRET).toBe('dev-only-insecure-secret')
  })
})
