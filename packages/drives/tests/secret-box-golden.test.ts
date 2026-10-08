import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DriveSecretBox } from '../src/secret-box.js'
import { DriveSecretMalformedError } from '../src/errors.js'

// BK-027: credentials sealed before the AEAD moved to @basaltkit/core still open.
const { bkd1 } = JSON.parse(readFileSync(new URL('../../core/tests/fixtures/secret-box-vectors.json', import.meta.url), 'utf8')) as {
  bkd1: { keys: { id: string; key: string }[]; vectors: { context: [string, string, string]; plaintext: string; envelope: string }[] }
}

describe('DriveSecretBox golden vectors (BK-027)', () => {
  const box = new DriveSecretBox(bkd1.keys)

  it('opens every pre-consolidation bkd1 envelope, and only for its own connection', () => {
    for (const { context, plaintext, envelope } of bkd1.vectors) {
      const [tenantId, connectionId, provider] = context
      expect(box.open(envelope, { tenantId, connectionId, provider })).toBe(plaintext)
      expect(() => box.open(envelope, { tenantId: `${tenantId}x`, connectionId, provider })).toThrow(DriveSecretMalformedError)
    }
  })

  it('reseal of a tampered current envelope is refused, not vouched for', () => {
    const context = { tenantId: 't', connectionId: 'c', provider: 'p' }
    const parts = box.seal('token', context).split('.')
    const tampered = [...parts.slice(0, 4), Buffer.from('forged').toString('base64url')].join('.')
    expect(() => box.reseal(tampered, context)).toThrow(DriveSecretMalformedError)
  })
})
