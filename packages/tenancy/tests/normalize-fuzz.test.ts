import { describe, expect, it } from 'vitest'
import { InvalidDomainError, normalizeDomain, tryNormalizeDomain } from '../src/index.js'

const PARTS = ['ACME', 'acme', 'Example', 'com', '.', ':443', ':80', ' ', 'WWW', 'xn--', 'café', 'a', '..', '@', '/', '%65', '１']
const rand = (i: number) => PARTS[i % PARTS.length]!

describe('normalizeDomain — total & idempotent (fuzz)', () => {
  it('either returns a canonical hostname or rejects; never rewrites into another host', () => {
    let accepted = 0
    for (let i = 0; i < 2000; i++) {
      const raw = Array.from({ length: 1 + (i % 5) }, (_, k) => rand(i + k)).join(
        i % 2 ? '.' : '',
      )
      let out: string | null = null
      expect(() => { out = tryNormalizeDomain(raw) }).not.toThrow()
      if (out === null) {
        expect(() => normalizeDomain(raw)).toThrow(InvalidDomainError)
        continue
      }
      accepted++
      const host: string = out
      expect(normalizeDomain(raw)).toBe(host)
      // idempotent: normalizing the result again is a fixed point
      expect(normalizeDomain(host)).toBe(host)
      // canonical: RFC 1123 characters only — no port, userinfo, path, `%`, unicode
      expect(host).toMatch(/^[a-z0-9.-]+$/)
      expect(host.endsWith('.')).toBe(false)
      // the result is the input minus case, whitespace, port and trailing dots —
      // never a different host carved out of it
      expect(raw.trim().toLowerCase().startsWith(host)).toBe(true)
    }
    expect(accepted).toBeGreaterThan(0)
  })
})
