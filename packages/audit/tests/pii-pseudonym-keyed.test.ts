import { createHash, createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPiiMinimizingRedactor, piiMinimizingRedactor, pseudonymize } from '../src/index.js'

const KEY = 'k'.repeat(32)

/** What an attacker holding only the audit trail can compute: an unkeyed hash of every candidate. */
function bruteForcePhone(token: string): string | undefined {
  for (let n = 0; n < 100_000; n++) {
    const candidate = `+24492${String(n).padStart(5, '0')}`
    const digest = createHash('sha256').update(candidate).digest('hex')
    if (token === `pii_${digest.slice(0, 16)}` || token === `pii_${digest.slice(0, 32)}`) return candidate
  }
  return undefined
}

afterEach(() => vi.restoreAllMocks())

describe('security · audit PII pseudonyms are keyed and not reversible from the trail (F65)', () => {
  it('a phone pseudonymized by the default PII redactor cannot be recovered by brute force', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = piiMinimizingRedactor({ phone: '+2449212345' }, 'user.created') as { phone: string }
    expect(out.phone).toMatch(/^pii_/)
    expect(bruteForcePhone(out.phone)).toBeUndefined()
  })

  it('a keyed redactor produces an HMAC-SHA256 pseudonym with at least 128 bits', () => {
    const redact = createPiiMinimizingRedactor({ key: KEY })
    const out = redact({ user: { email: 'alice@example.com', phone: '+2449212345' }, password: 'x' }, 'e') as {
      user: { email: string; phone: string }
      password: string
    }
    const expected = `pii_${createHmac('sha256', KEY).update('alice@example.com').digest('hex').slice(0, 32)}`
    expect(out.user.email).toBe(expected)
    expect(out.user.email).toBe(pseudonymize('alice@example.com', KEY))
    expect(out.user.email.length - 'pii_'.length).toBeGreaterThanOrEqual(32)
    expect(bruteForcePhone(out.user.phone)).toBeUndefined()
    expect(out.password).toBe('[redacted]')
  })

  it('stays deterministic for one key (correlatable) and differs across keys', () => {
    expect(pseudonymize('+2449212345', KEY)).toBe(pseudonymize('+2449212345', KEY))
    expect(pseudonymize('+2449212345', KEY)).not.toBe(pseudonymize('+2449212345', 'z'.repeat(32)))
  })

  it('rejects a key shorter than 128 bits', () => {
    expect(() => createPiiMinimizingRedactor({ key: 'short' })).toThrow(/key/i)
    expect(() => pseudonymize('a@b.co', 'short')).toThrow(/key/i)
  })

  it('warns when PII is pseudonymized without a configured key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const redact = createPiiMinimizingRedactor()
    redact({ email: 'bob@example.com' }, 'e')
    expect(warn.mock.calls.some((call) => String(call[0]).includes('key'))).toBe(true)
  })
})
