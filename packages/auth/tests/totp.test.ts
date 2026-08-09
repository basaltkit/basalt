import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, otpauthUri, totp, verifyTotp } from '../src/index.js'

// RFC 6238 test vector secret: ASCII "12345678901234567890".
const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trips', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world')
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })

  it('matches the published 6-digit vectors', () => {
    const cases: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [seconds, expected] of cases) {
      expect(totp(secret, { now: seconds * 1000 })).toBe(expected)
    }
  })

  it('verifies within the drift window and rejects outside it', () => {
    const now = 1111111111 * 1000
    expect(verifyTotp(secret, '050471', { now })).toBe(true)
    // one step earlier is accepted with window 1
    expect(verifyTotp(secret, totp(secret, { now: now - 30_000 }), { now })).toBe(true)
    // two steps away is rejected
    expect(verifyTotp(secret, totp(secret, { now: now - 90_000 }), { now, window: 1 })).toBe(false)
    expect(verifyTotp(secret, '000000', { now })).toBe(false)
  })

  it('builds an otpauth URI with issuer and secret', () => {
    const uri = otpauthUri({ secret, account: 'ada@acme.test', issuer: 'Basalt' })
    expect(uri.startsWith('otpauth://totp/Basalt:ada%40acme.test?')).toBe(true)
    expect(uri).toContain(`secret=${secret}`)
    expect(uri).toContain('issuer=Basalt')
  })
})
