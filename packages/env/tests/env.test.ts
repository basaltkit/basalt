import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineEnv, EnvValidationError } from '../src/index.js'

describe('defineEnv', () => {
  it('returns a typed, frozen object with defaults applied', () => {
    const env = defineEnv(
      {
        DATABASE_URL: z.string().url(),
        PORT: z.coerce.number().default(3000),
      },
      { source: { DATABASE_URL: 'postgres://localhost:5432/app' } },
    )
    expect(env.DATABASE_URL).toBe('postgres://localhost:5432/app')
    expect(env.PORT).toBe(3000)
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('reads process.env when no options are given', () => {
    process.env['BASALT_ENV_SMOKE'] = '7'
    try {
      expect(defineEnv({ BASALT_ENV_SMOKE: z.coerce.number() }).BASALT_ENV_SMOKE).toBe(7)
    } finally {
      delete process.env['BASALT_ENV_SMOKE']
    }
  })

  it('keeps the full path for a nested failure', () => {
    try {
      defineEnv(
        { TAGS: z.preprocess((value) => String(value).split(','), z.array(z.string().min(2))) },
        { source: { TAGS: 'ok,x' } },
      )
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^TAGS\.1: /)
    }
  })

  it('reports a non-object source as (root)', () => {
    try {
      defineEnv({}, { source: 'not-an-object' as unknown as Record<string, string | undefined> })
      expect.unreachable()
    } catch (error) {
      expect((error as EnvValidationError).report[0]).toMatch(/^\(root\): /)
    }
  })

  it('aggregates ALL errors into a single report', () => {
    try {
      defineEnv(
        {
          DATABASE_URL: z.string().url(),
          REDIS_URL: z.string().url(),
          PORT: z.coerce.number(),
        },
        { source: { PORT: 'abc' } },
      )
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError)
      const { report, code } = error as EnvValidationError
      expect(code).toBe('ENV_INVALID')
      expect(report).toHaveLength(3)
      expect(report.join('\n')).toMatch(/DATABASE_URL/)
      expect(report.join('\n')).toMatch(/REDIS_URL/)
      expect(report.join('\n')).toMatch(/PORT/)
    }
  })
})
