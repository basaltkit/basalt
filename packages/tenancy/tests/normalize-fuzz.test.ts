import { describe, expect, it } from 'vitest'
import { normalizeDomain } from '../src/index.js'

const PARTS = ['ACME', 'acme', 'Example', 'com', '.', ':443', ':80', ' ', 'WWW', 'xn--', 'café', 'a', '..']
const rand = (i: number) => PARTS[i % PARTS.length]!

describe('normalizeDomain — total & idempotent (fuzz)', () => {
  it('never throws and is idempotent + canonical across 2000 inputs', () => {
    for (let i = 0; i < 2000; i++) {
      const raw = Array.from({ length: 1 + (i % 5) }, (_, k) => rand(i + k)).join(
        i % 2 ? '.' : '',
      )
      let out = ''
      expect(() => { out = normalizeDomain(raw) }).not.toThrow()
      // idempotent: normalizing the result again is a fixed point
      expect(normalizeDomain(out)).toBe(out)
      // canonical: no uppercase, no surrounding space, no trailing dot, no port
      expect(out).toBe(out.toLowerCase())
      expect(out).toBe(out.trim())
      expect(out.endsWith('.')).toBe(false)
      expect(out.includes(':')).toBe(false)
    }
  })
})
