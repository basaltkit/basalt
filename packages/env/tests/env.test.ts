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
