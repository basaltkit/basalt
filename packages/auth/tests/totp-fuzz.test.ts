import { describe, expect, it } from 'vitest'
import { generateTotpSecret, totp, verifyTotp, matchTotpStep } from '../src/index.js'

describe('TOTP — roundtrip & robustness (fuzz)', () => {
  it('a freshly generated code always verifies at the same instant (500 cases)', () => {
    for (let i = 0; i < 500; i++) {
      const secret = generateTotpSecret()
      const now = Math.floor(Math.random() * 4_000_000_000_000)
      const code = totp(secret, { now })
      expect(verifyTotp(secret, code, { now })).toBe(true)
    }
  })

  it('never throws on garbage tokens and rejects them', () => {
    const secret = generateTotpSecret()
    const garbage = ['', 'abcdef', '12', '99999999', '  ', '000000', 'null', '<script>']
    for (const g of garbage) {
      let step: number | null = 0
      expect(() => { step = matchTotpStep(secret, g) }).not.toThrow()
      if (g !== totp(secret)) expect(step).toBeNull()
    }
  })
})
