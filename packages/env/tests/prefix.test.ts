import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEnv, EnvPrefixError, EnvValidationError, secret } from '../src/index.js'

const nodeEnv = process.env['NODE_ENV']

afterEach(() => {
  if (nodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = nodeEnv
})

describe('defineEnv({ prefix })', () => {
  it('reads <PREFIX>_<NAME>', () => {
    const env = defineEnv(
      { PORT: z.coerce.number(), DATABASE_URL: z.string().url() },
      {
        prefix: 'MY_SAAS',
        source: { MY_SAAS_PORT: '4000', MY_SAAS_DATABASE_URL: 'postgres://localhost:5432/app' },
      },
    )
    expect(env.PORT).toBe(4000)
    expect(env.DATABASE_URL).toBe('postgres://localhost:5432/app')
  })

  it('falls back to the bare name when the prefixed one is unset', () => {
    const env = defineEnv({ PORT: z.coerce.number() }, { prefix: 'MY_SAAS', source: { PORT: '5000' } })
    expect(env.PORT).toBe(5000)
  })

  it('prefers the prefixed name over the bare one', () => {
    const env = defineEnv(
      { PORT: z.coerce.number() },
      { prefix: 'MY_SAAS', source: { MY_SAAS_PORT: '4000', PORT: '5000' } },
    )
    expect(env.PORT).toBe(4000)
  })

  it('prefers an EMPTY prefixed value over the bare one (set is set)', () => {
    try {
      defineEnv(
        { PORT: z.coerce.number().min(1) },
        { prefix: 'MY_SAAS', source: { MY_SAAS_PORT: '', PORT: '5000' } },
      )
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^MY_SAAS_PORT: /)
    }
  })

  it('names BOTH keys when a variable is missing', () => {
    try {
      defineEnv({ DATABASE_URL: z.string().url() }, { prefix: 'MY_SAAS', source: {} })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      expect((error as EnvValidationError).report[0]).toMatch(
        /^MY_SAAS_DATABASE_URL \(or DATABASE_URL\): /,
      )
    }
  })

  it('names only the prefixed key when the fallback is off', () => {
    try {
      defineEnv(
        { DATABASE_URL: z.string().url() },
        { prefix: { value: 'MY_SAAS', fallback: false }, source: { DATABASE_URL: 'postgres://x/y' } },
      )
      expect.unreachable()
    } catch (error) {
      const { report } = error as EnvValidationError
      expect(report[0]).toMatch(/^MY_SAAS_DATABASE_URL: /)
      expect(report[0]).not.toMatch(/\(or DATABASE_URL\)/)
    }
  })

  it('names the key the value actually came from when it is invalid', () => {
    try {
      defineEnv({ PORT: z.coerce.number() }, { prefix: 'MY_SAAS', source: { PORT: 'abc' } })
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^PORT: /)
    }

    try {
      defineEnv({ PORT: z.coerce.number() }, { prefix: 'MY_SAAS', source: { MY_SAAS_PORT: 'abc' } })
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^MY_SAAS_PORT: /)
    }
  })

  it('NEVER prefixes NODE_ENV', () => {
    const env = defineEnv(
      { NODE_ENV: z.enum(['development', 'production', 'test']).default('production') },
      { prefix: 'MY_SAAS', source: { NODE_ENV: 'development', MY_SAAS_NODE_ENV: 'test' } },
    )
    expect(env.NODE_ENV).toBe('development')
  })

  it('reports NODE_ENV under its bare name', () => {
    try {
      defineEnv(
        { NODE_ENV: z.enum(['development', 'production', 'test']) },
        { prefix: 'MY_SAAS', source: {} },
      )
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^NODE_ENV: /)
    }
  })

  it('keeps the shape keys on the returned object (env.PORT, not env.MY_SAAS_PORT)', () => {
    const env = defineEnv({ PORT: z.coerce.number() }, { prefix: 'MY_SAAS', source: { MY_SAAS_PORT: '4000' } })
    expect(Object.keys(env)).toEqual(['PORT'])
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('applies defaults when neither name is set', () => {
    const env = defineEnv({ PORT: z.coerce.number().default(3000) }, { prefix: 'MY_SAAS', source: {} })
    expect(env.PORT).toBe(3000)
  })

  describe('secret()', () => {
    it('reads the prefixed secret', () => {
      process.env['NODE_ENV'] = 'production'
      const env = defineEnv(
        { APP_SECRET: secret({ devDefault: 'dev-only-insecure-value' }) },
        { prefix: 'MY_SAAS', source: { MY_SAAS_APP_SECRET: 'Zq4t7w9z2C5f8jKb' } },
      )
      expect(env.APP_SECRET).toBe('Zq4t7w9z2C5f8jKb')
    })

    it('applies devDefault when NEITHER name is set and NODE_ENV=development', () => {
      process.env['NODE_ENV'] = 'development'
      const env = defineEnv(
        { APP_SECRET: secret({ devDefault: 'dev-only-insecure-value' }) },
        { prefix: 'MY_SAAS', source: {} },
      )
      expect(env.APP_SECRET).toBe('dev-only-insecure-value')
    })

    it('stays fail-closed with an unset NODE_ENV and names both keys', () => {
      delete process.env['NODE_ENV']
      try {
        defineEnv(
          { APP_SECRET: secret({ devDefault: 'dev-only-insecure-value' }) },
          { prefix: 'MY_SAAS', source: {} },
        )
        expect.unreachable()
      } catch (error) {
        expect((error as EnvValidationError).report[0]).toMatch(
          /^MY_SAAS_APP_SECRET \(or APP_SECRET\): /,
        )
      }
    })
  })

  describe('prefix validation', () => {
    it('accepts uppercase letters, digits and inner underscores', () => {
      for (const value of ['MY_SAAS', 'APP', 'A1_B2_C3']) {
        expect(() => defineEnv({}, { prefix: value, source: {} })).not.toThrow()
      }
    })

    it('rejects anything else', () => {
      for (const value of ['my_saas', 'MY-SAAS', '_MY', 'MY_', '1APP', 'MY SAAS', '', 'MY__SAAS']) {
        expect(() => defineEnv({}, { prefix: value, source: {} })).toThrow(EnvPrefixError)
      }
    })

    it('names the offending prefix and the expected shape', () => {
      try {
        defineEnv({}, { prefix: 'my-saas', source: {} })
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(EnvPrefixError)
        expect((error as EnvPrefixError).code).toBe('ENV_PREFIX_INVALID')
        expect((error as EnvPrefixError).message).toContain('my-saas')
        expect((error as EnvPrefixError).message).toContain('MY_SAAS')
      }
    })
  })

  it('changes nothing when no prefix is given', () => {
    const env = defineEnv({ PORT: z.coerce.number() }, { source: { PORT: '5000', MY_SAAS_PORT: '4000' } })
    expect(env.PORT).toBe(5000)
    try {
      defineEnv({ DATABASE_URL: z.string().url() }, { source: {} })
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^DATABASE_URL: /)
    }
  })
})
