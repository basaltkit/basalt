import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signPayload, verifySignature } from '../src/index.js'

const SECRET = 'whsec_bytes_0123456789abcdef'

describe('BK-082 — signatures over raw bytes', () => {
  it('a string and the Buffer of its UTF-8 bytes produce the same signature', () => {
    const body = '{"name":"Ação ✓","n":1}'
    const fromString = signPayload(body, SECRET, 1000)
    expect(signPayload(Buffer.from(body, 'utf8'), SECRET, 1000)).toBe(fromString)
    expect(signPayload(new TextEncoder().encode(body), SECRET, 1000)).toBe(fromString)
    // Either representation verifies against either signature.
    expect(verifySignature(fromString, Buffer.from(body, 'utf8'), SECRET, 300, 1000)).toBe(true)
    expect(verifySignature(fromString, body, SECRET, 300, 1000)).toBe(true)
  })

  it('keeps string signatures byte-identical to the historical `${t}.${body}` HMAC', () => {
    const body = '{"a":"é"}'
    const legacy = createHmac('sha256', SECRET).update(`1000.${body}`).digest('hex')
    expect(signPayload(body, SECRET, 1000)).toBe(`t=1000,v1=${legacy}`)
  })

  it('verifies a non-UTF-8 body byte-for-byte (no lossy decode)', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41, 0xc3])
    const header = signPayload(raw, SECRET, 1000)
    expect(verifySignature(header, raw, SECRET, 300, 1000)).toBe(true)
    // Decoding to a string replaces the invalid sequences and breaks the HMAC.
    expect(verifySignature(header, raw.toString('utf8'), SECRET, 300, 1000)).toBe(false)
  })

  it('a single tampered byte fails verification', () => {
    const raw = Buffer.from('From: a@b.c\r\nSubject: hi\r\n\r\nbody', 'utf8')
    const header = signPayload(raw, SECRET, 1000)
    const tampered = Buffer.from(raw)
    tampered[tampered.length - 1]! ^= 0x01
    expect(verifySignature(header, tampered, SECRET, 300, 1000)).toBe(false)
  })

  it('a body that is neither a string nor bytes is refused (fail closed)', () => {
    const header = signPayload('{}', SECRET, 1000)
    expect(verifySignature(header, { a: 1 } as unknown as string, SECRET, 300, 1000)).toBe(false)
    expect(() => signPayload({ a: 1 } as unknown as string, SECRET, 1000)).toThrow(TypeError)
  })
})
