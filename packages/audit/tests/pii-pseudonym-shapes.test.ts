import { describe, expect, it } from 'vitest'
import { createPiiMinimizingRedactor, pseudonymize } from '../src/index.js'

const KEY = 'k'.repeat(32)
const PHONE = '+244923456789'

describe('security · audit PII redactor pseudonymizes every value shape under a PII key (F65 bypass)', () => {
  const redact = createPiiMinimizingRedactor({ key: KEY })
  const stored = (payload: unknown) => JSON.stringify(redact(payload, 'user.updated'))

  it('a numeric phone is pseudonymized, not persisted raw', () => {
    const out = redact({ phone: 244923456789 }, 'e') as { phone: unknown }
    expect(out.phone).toBe(pseudonymize('244923456789', KEY))
    expect(stored({ msisdn: 244923456789n })).not.toContain('244923456789')
  })

  it('a list of phones under a PII key is pseudonymized element by element', () => {
    const out = redact({ phones: [PHONE, '+244911111111'] }, 'e') as { phones: string[] }
    expect(out.phones).toEqual([pseudonymize(PHONE, KEY), pseudonymize('+244911111111', KEY)])
  })

  it('a nested object under a PII key does not leak its leaves', () => {
    const json = stored({ phone: { number: PHONE, country: 'AO' }, passport: { id: 'N1234567' } })
    expect(json).not.toContain(PHONE)
    expect(json).not.toContain('N1234567')
  })

  it('secrets under a PII key are still masked', () => {
    const out = redact({ email: { address: 'a@b.co', token: 't0p' } }, 'e') as { email: Record<string, unknown> }
    expect(out.email['token']).toBe('[redacted]')
  })

  it('rejects a key that is neither a string nor bytes at configuration time', () => {
    expect(() => createPiiMinimizingRedactor({ key: 1234567890123456789 as unknown as string })).toThrow(TypeError)
    expect(() => createPiiMinimizingRedactor({ key: { byteLength: 64 } as unknown as Uint8Array })).toThrow(TypeError)
  })
})
