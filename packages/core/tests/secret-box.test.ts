import { createCipheriv, hkdfSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSecretBox, SecretBoxError, type SecretBoxPrimitive } from '../src/secret-box.js'

/**
 * BK-027: the shared AEAD behind auth's `SecretBox` (bka2) and drives'
 * `DriveSecretBox` (bkd1). The fixtures were sealed by the pre-consolidation
 * implementations of both packages; every one must still open, byte for byte.
 */

interface VectorSet {
  info: string
  keys: { id: string; key: string }[]
  vectors: { context: string[]; plaintext: string; envelope: string }[]
}
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/secret-box-vectors.json', import.meta.url), 'utf8')) as Record<
  'bka2' | 'bkd1',
  VectorSet
>

const boxFor = (version: 'bka2' | 'bkd1'): SecretBoxPrimitive => {
  const set = fixtures[version]
  return createSecretBox({ keys: set.keys, info: set.info, version, aadFields: set.vectors[0]!.context.length })
}

/** The envelope format re-derived independently, to pin what seal() writes. */
const referenceSeal = (set: VectorSet, version: string, keyIndex: number, iv: Buffer, plaintext: string, context: string[]) => {
  const entry = set.keys[keyIndex]!
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(entry.key, 'utf8'), Buffer.alloc(0), set.info, 32))
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  cipher.setAAD(Buffer.from([version, entry.id, ...context].join('\0'), 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [version, entry.id, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

const failureOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return error instanceof SecretBoxError ? error.failure : 'other'
  }
  return undefined
}

describe.each(['bka2', 'bkd1'] as const)('createSecretBox golden vectors (%s)', (version) => {
  const set = fixtures[version]
  const box = boxFor(version)

  it('opens every ciphertext written by the previous implementation', () => {
    for (const v of set.vectors) expect(box.open(v.envelope, v.context)).toBe(v.plaintext)
  })

  it('writes exactly the same envelope format (independent re-derivation)', () => {
    for (const v of set.vectors) {
      const sealed = box.seal(v.plaintext, v.context)
      const iv = Buffer.from(sealed.split('.')[2]!, 'base64url')
      expect(sealed).toBe(referenceSeal(set, version, 0, iv, v.plaintext, v.context))
      expect(box.open(sealed, v.context)).toBe(v.plaintext)
    }
  })

  it('refuses a ciphertext under any other context (cross-AAD)', () => {
    for (const v of set.vectors) {
      const other = [...v.context]
      other[other.length - 1] = `${other[other.length - 1]}-x`
      expect(failureOf(() => box.open(v.envelope, other))).toBe('auth-failed')
      // Field order is part of the binding.
      expect(failureOf(() => box.open(v.envelope, [...v.context].reverse()))).toBe('auth-failed')
    }
  })

  it('isCurrent / keyIdOf / reseal follow the active key', () => {
    const old = set.vectors.find((v) => v.plaintext === 'sealed-with-old-key')!
    expect(box.isCurrent(old.envelope)).toBe(false)
    expect(box.keyIdOf(old.envelope)).toBe(set.keys[1]!.id)
    const resealed = box.reseal(old.envelope, old.context)!
    expect(box.keyIdOf(resealed)).toBe(set.keys[0]!.id)
    expect(box.open(resealed, old.context)).toBe(old.plaintext)
    expect(box.reseal(resealed, old.context)).toBeNull()
  })
})

describe('createSecretBox', () => {
  const KEY = 'k'.repeat(32)
  const box = createSecretBox({ keys: [{ id: 'a', key: KEY }], info: 'test:box', version: 'tst1', aadFields: 2 })

  it('refuses plaintext and other versions; there is no pass-through path', () => {
    expect(failureOf(() => box.open('hello', ['p', 's']))).toBe('malformed')
    expect(failureOf(() => box.open('bka2.a.x.y.z', ['p', 's']))).toBe('malformed')
    expect(failureOf(() => box.open('tst1.a.x', ['p', 's']))).toBe('malformed')
    const foreign = fixtures.bka2.vectors[0]!
    expect(failureOf(() => box.open(foreign.envelope, foreign.context))).toBe('malformed')
  })

  it('a different info label or version never opens the other box', () => {
    const sealed = box.seal('x', ['p', 's'])
    const otherInfo = createSecretBox({ keys: [{ id: 'a', key: KEY }], info: 'test:other', version: 'tst1', aadFields: 2 })
    expect(failureOf(() => otherInfo.open(sealed, ['p', 's']))).toBe('auth-failed')
  })

  it('rotation: a new active key still opens the old one; an unknown key id is reported as such', () => {
    const sealed = box.seal('secret', ['p', 's'])
    const rotated = createSecretBox({ keys: [{ id: 'b', key: 'b'.repeat(32) }, { id: 'a', key: KEY }], info: 'test:box', version: 'tst1', aadFields: 2 })
    expect(rotated.open(sealed, ['p', 's'])).toBe('secret')
    expect(rotated.isCurrent(sealed)).toBe(false)
    const dropped = createSecretBox({ keys: [{ id: 'b', key: 'b'.repeat(32) }], info: 'test:box', version: 'tst1', aadFields: 2 })
    let caught: unknown
    try {
      dropped.open(sealed, ['p', 's'])
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SecretBoxError)
    expect((caught as SecretBoxError).failure).toBe('unknown-key')
    expect((caught as SecretBoxError).keyId).toBe('a')
  })

  it('reseal of a current envelope returns null but still authenticates it', () => {
    const sealed = box.seal('secret', ['p', 's'])
    expect(box.reseal(sealed, ['p', 's'])).toBeNull()
    const parts = sealed.split('.')
    const tampered = [...parts.slice(0, 4), Buffer.from('tampered').toString('base64url')].join('.')
    expect(failureOf(() => box.reseal(tampered, ['p', 's']))).toBe('auth-failed')
  })

  it('refuses a truncated tag and tampered ciphertext', () => {
    const parts = box.seal('secret', ['p', 's']).split('.')
    expect(failureOf(() => box.open([...parts.slice(0, 3), parts[3]!.slice(0, 8), parts[4]].join('.'), ['p', 's']))).toBe('auth-failed')
    expect(failureOf(() => box.open([parts[0], 'zz', ...parts.slice(2)].join('.'), ['p', 's']))).toBe('unknown-key')
  })

  it('NUL inside a context field, or the wrong field count, is an error on seal and open', () => {
    const sealed = box.seal('x', ['p', 's'])
    expect(failureOf(() => box.seal('x', ['p\0', 's']))).toBe('context')
    expect(failureOf(() => box.open(sealed, ['p', 's\0']))).toBe('context')
    expect(failureOf(() => box.seal('x', ['p']))).toBe('context')
    expect(failureOf(() => box.open(sealed, ['p', 's', 'extra']))).toBe('context')
  })

  it('validates its configuration', () => {
    const ok = { keys: [{ id: 'a', key: KEY }], info: 'i', version: 'v1', aadFields: 1 }
    expect(failureOf(() => createSecretBox({ ...ok, keys: [] }))).toBe('config')
    expect(failureOf(() => createSecretBox({ ...ok, keys: [{ id: 'a', key: 'short' }] }))).toBe('config')
    expect(failureOf(() => createSecretBox({ ...ok, keys: [{ id: 'has.dot', key: KEY }] }))).toBe('config')
    expect(failureOf(() => createSecretBox({ ...ok, keys: [{ id: 'a', key: KEY }, { id: 'a', key: KEY }] }))).toBe('config')
    expect(failureOf(() => createSecretBox({ ...ok, version: 'has.dot' }))).toBe('config')
    expect(failureOf(() => createSecretBox({ ...ok, info: '' }))).toBe('config')
    expect(failureOf(() => createSecretBox({ ...ok, aadFields: 0 }))).toBe('config')
    expect(failureOf(() => createSecretBox(ok))).toBeUndefined()
  })

  it('is not exported from the core barrel (subpath only)', async () => {
    const barrel = (await import('../src/index.js')) as Record<string, unknown>
    expect(barrel['createSecretBox']).toBeUndefined()
    expect(barrel['SecretBoxError']).toBeUndefined()
  })
})
