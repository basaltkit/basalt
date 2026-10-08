import { describe, expect, it } from 'vitest'
import { isRawBody, isUploadBody, rawBody, rawBodyOptionsOf, upload, uploadOptionsOf } from '../src/index.js'

/**
 * BK-038: the rawBody()/upload() markers are global symbols, so a schema built
 * by one installed copy of @basaltkit/http is recognised by another. The
 * end-to-end check runs on every adapter in `adapter-parity.ts`
 * (`crossCopyParitySuite`); these pin the marker's shape.
 */
describe('body markers', () => {
  it('recognises a marker written by another copy (same global symbol)', () => {
    const foreign = {}
    Object.defineProperty(foreign, Symbol.for('basalt.http.rawBody'), { value: { maxBytes: 512 } })
    expect(isRawBody(foreign)).toBe(true)
    expect(rawBodyOptionsOf(foreign)).toEqual({ maxBytes: 512 })

    const foreignUpload = {}
    Object.defineProperty(foreignUpload, Symbol.for('basalt.http.upload'), { value: { maxBytes: 10, maxFiles: 1 } })
    expect(isUploadBody(foreignUpload)).toBe(true)
  })

  it('keeps the marker out of enumeration and refuses to let it be rewritten', () => {
    const schema = rawBody({ maxBytes: 100 })
    expect(Object.keys(schema)).not.toContain(String(Symbol.for('basalt.http.rawBody')))
    expect(Object.getOwnPropertySymbols({ ...schema })).not.toContain(Symbol.for('basalt.http.rawBody'))
    expect(() => {
      ;(rawBodyOptionsOf(schema) as { maxBytes: number }).maxBytes = 10_000_000
    }).toThrow(TypeError)
    expect(rawBodyOptionsOf(schema)).toEqual({ maxBytes: 100 })
    expect(uploadOptionsOf(upload({ maxBytes: 50, maxFiles: 1 }))?.maxBytes).toBe(50)
  })

  it('ignores a malformed marker', () => {
    const bogus = {}
    Object.defineProperty(bogus, Symbol.for('basalt.http.rawBody'), { value: { maxBytes: 'lots' } })
    expect(isRawBody(bogus)).toBe(false)
    expect(isRawBody(null)).toBe(false)
    expect(isUploadBody('x')).toBe(false)
  })
})
