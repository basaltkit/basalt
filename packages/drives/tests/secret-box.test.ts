import { describe, expect, it } from 'vitest'
import { DriveSecretBox, randomToken, safeEqual } from '../src/secret-box.js'
import { DriveSecretKeyInvalidError, DriveSecretKeyUnknownError, DriveSecretMalformedError } from '../src/errors.js'

const KEY_A = { id: 'k1', key: 'a'.repeat(32) }
const KEY_B = { id: 'k2', key: 'b'.repeat(32) }

const context = { tenantId: 'acme', connectionId: 'conn-1', provider: 'fake' }

describe('DriveSecretBox', () => {
  it('round-trips a secret', () => {
    const box = new DriveSecretBox([KEY_A])
    const sealed = box.seal('refresh-token-value', context)
    expect(sealed).not.toContain('refresh-token-value')
    expect(box.open(sealed, context)).toBe('refresh-token-value')
  })

  it('produces a different ciphertext every time (random IV)', () => {
    const box = new DriveSecretBox([KEY_A])
    expect(box.seal('x', context)).not.toBe(box.seal('x', context))
  })

  describe('AAD binding — the property @basaltkit/auth’s box lacks', () => {
    it('refuses a blob moved to another tenant', () => {
      const box = new DriveSecretBox([KEY_A])
      const sealed = box.seal('tenant-a-refresh-token', context)
      expect(() => box.open(sealed, { ...context, tenantId: 'globex' })).toThrow(DriveSecretMalformedError)
    })

    it('refuses a blob moved to another connection of the same tenant', () => {
      const box = new DriveSecretBox([KEY_A])
      const sealed = box.seal('finance-token', context)
      expect(() => box.open(sealed, { ...context, connectionId: 'conn-2' })).toThrow(DriveSecretMalformedError)
    })

    it('refuses a blob moved to another provider', () => {
      const box = new DriveSecretBox([KEY_A])
      const sealed = box.seal('token', context)
      expect(() => box.open(sealed, { ...context, provider: 'other' })).toThrow(DriveSecretMalformedError)
    })
  })

  describe('fail-closed', () => {
    it('never returns a non-envelope value as plaintext', () => {
      const box = new DriveSecretBox([KEY_A])
      // The legacy passthrough in @basaltkit/auth's box would return this
      // verbatim; here an attacker-written column is corruption, not a secret.
      expect(() => box.open('plaintext-token', context)).toThrow(DriveSecretMalformedError)
    })

    it('rejects a tampered tag', () => {
      const box = new DriveSecretBox([KEY_A])
      const sealed = box.seal('token', context)
      const parts = sealed.split('.')
      parts[3] = Buffer.from('0'.repeat(16)).toString('base64url')
      expect(() => box.open(parts.join('.'), context)).toThrow(DriveSecretMalformedError)
    })

    it('rejects a truncated envelope', () => {
      const box = new DriveSecretBox([KEY_A])
      expect(() => box.open('bkd1.k1.aa.bb', context)).toThrow(DriveSecretMalformedError)
    })

    it('rejects a wrong key', () => {
      const sealed = new DriveSecretBox([KEY_A]).seal('token', context)
      const other = new DriveSecretBox([{ id: 'k1', key: 'z'.repeat(32) }])
      expect(() => other.open(sealed, context)).toThrow(DriveSecretMalformedError)
    })
  })

  describe('key ring and rotation', () => {
    it('seals with the first key', () => {
      const box = new DriveSecretBox([KEY_B, KEY_A])
      expect(box.activeKeyId).toBe('k2')
      expect(box.keyIdOf(box.seal('t', context))).toBe('k2')
    })

    it('still reads a secret sealed by a retired key', () => {
      const sealed = new DriveSecretBox([KEY_A]).seal('old-token', context)
      const rotated = new DriveSecretBox([KEY_B, KEY_A])
      expect(rotated.open(sealed, context)).toBe('old-token')
    })

    it('reseals onto the active key, and reports nothing to do when already current', () => {
      const old = new DriveSecretBox([KEY_A]).seal('t', context)
      const rotated = new DriveSecretBox([KEY_B, KEY_A])
      const resealed = rotated.reseal(old, context)
      expect(resealed).not.toBeNull()
      expect(rotated.keyIdOf(resealed as string)).toBe('k2')
      expect(rotated.reseal(resealed as string, context)).toBeNull()
    })

    it('names the missing key when a ring dropped it', () => {
      const sealed = new DriveSecretBox([KEY_A]).seal('t', context)
      expect(() => new DriveSecretBox([KEY_B]).open(sealed, context)).toThrow(DriveSecretKeyUnknownError)
    })
  })

  describe('configuration validation', () => {
    it('requires at least one key', () => {
      expect(() => new DriveSecretBox([])).toThrow(DriveSecretKeyInvalidError)
    })

    it('rejects a short key', () => {
      expect(() => new DriveSecretBox([{ id: 'k', key: 'short' }])).toThrow(DriveSecretKeyInvalidError)
    })

    it('rejects a key id that would not survive the envelope encoding', () => {
      expect(() => new DriveSecretBox([{ id: 'has.dot', key: 'a'.repeat(32) }])).toThrow(DriveSecretKeyInvalidError)
    })

    it('rejects duplicate key ids', () => {
      expect(() => new DriveSecretBox([KEY_A, { id: 'k1', key: 'c'.repeat(32) }])).toThrow(DriveSecretKeyInvalidError)
    })

    it('accepts raw bytes as key material', () => {
      const box = new DriveSecretBox([{ id: 'bin', key: new Uint8Array(32).fill(7) }])
      expect(box.open(box.seal('t', context), context)).toBe('t')
    })
  })
})

describe('safeEqual', () => {
  it('matches equal strings and rejects different ones', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false for different lengths instead of throwing', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('randomToken', () => {
  it('produces url-safe, unique values', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})
