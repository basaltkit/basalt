import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SecretBox, SecretUnreadableError } from '../src/index.js'

// BK-027: TOTP secrets sealed before the AEAD moved to @basaltkit/core still open.
const { bka2 } = JSON.parse(readFileSync(new URL('../../core/tests/fixtures/secret-box-vectors.json', import.meta.url), 'utf8')) as {
  bka2: { keys: { id: string; key: string }[]; vectors: { context: [string, string]; plaintext: string; envelope: string }[] }
}

describe('SecretBox golden vectors (BK-027)', () => {
  const box = new SecretBox({ keys: bka2.keys })

  it('opens every pre-consolidation bka2 envelope, and only for its own record', () => {
    for (const { context, plaintext, envelope } of bka2.vectors) {
      expect(box.open(envelope, { purpose: context[0], subject: context[1] })).toBe(plaintext)
      expect(() => box.open(envelope, { purpose: context[0], subject: `${context[1]}-other` })).toThrow(SecretUnreadableError)
    }
  })

  it('still refuses an empty subject (auth-level rule on top of the primitive)', () => {
    expect(() => box.seal('x', { purpose: 'totp', subject: '' })).toThrow(SecretUnreadableError)
  })
})
