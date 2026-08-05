import { describe, expect, it } from 'vitest'
import { parseDuration } from '../src/index.js'

describe('parseDuration', () => {
  it('converts human-readable strings to milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('1.5d')).toBe(129_600_000)
  })

  it('accepts numbers as direct milliseconds', () => {
    expect(parseDuration(1500)).toBe(1500)
  })

  it('rejects invalid formats with a typed error', () => {
    for (const invalid of ['abc', '10x', '-5s', Number.NaN, -1]) {
      try {
        parseDuration(invalid as never)
        expect.unreachable()
      } catch (error) {
        expect((error as { code: string }).code).toBe('DURATION_INVALID')
      }
    }
  })
})
