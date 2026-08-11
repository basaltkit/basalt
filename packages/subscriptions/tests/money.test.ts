import { describe, expect, it } from 'vitest'
import {
  assertMinorUnits,
  currencyDecimals,
  formatMoney,
  isMinorUnits,
  toMajor,
  toMinor,
} from '../src/index.js'

describe('money', () => {
  it('knows currency decimals', () => {
    expect(currencyDecimals('AOA')).toBe(2)
    expect(currencyDecimals('usd')).toBe(2)
    expect(currencyDecimals('JPY')).toBe(0)
    expect(currencyDecimals('XOF')).toBe(0)
    expect(currencyDecimals('ZZZ')).toBe(2) // default
  })

  it('converts major <-> minor', () => {
    expect(toMinor(5000, 'AOA')).toBe(500000)
    expect(toMinor(29.99, 'USD')).toBe(2999)
    expect(toMinor(1000, 'JPY')).toBe(1000) // 0-decimal currency
    expect(toMajor(500000, 'AOA')).toBe(5000)
    expect(toMajor(2999, 'USD')).toBe(29.99)
  })

  it('rounds to the currency precision (no float drift)', () => {
    expect(toMinor(0.1 + 0.2, 'USD')).toBe(30) // 0.30 -> 30, not 30.000000004
  })

  it('validates minor units', () => {
    expect(isMinorUnits(2999)).toBe(true)
    expect(isMinorUnits(0)).toBe(true)
    expect(isMinorUnits(29.99)).toBe(false)
    expect(isMinorUnits(-1)).toBe(false)
    expect(() => assertMinorUnits(2999)).not.toThrow()
    expect(() => assertMinorUnits(29.99)).toThrow(RangeError)
    expect(() => assertMinorUnits(-5)).toThrow(RangeError)
  })

  it('formats for display', () => {
    // exact string varies by ICU, but it must contain the major amount
    expect(formatMoney(500000, 'AOA', 'pt-PT')).toContain('5')
    expect(formatMoney(2999, 'USD', 'en-US')).toBe('$29.99')
  })
})
