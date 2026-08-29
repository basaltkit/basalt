import { describe, expect, it } from 'vitest'
import { redactSensitive, redactSensitiveAndPii } from '../src/index.js'

const nest = (depth: number, leaf: Record<string, unknown>): Record<string, unknown> => {
  let node: Record<string, unknown> = leaf
  for (let i = 0; i < depth; i++) node = { level: node }
  return node
}

const dig = (value: unknown, depth: number): unknown => {
  let node = value
  for (let i = 0; i < depth; i++) node = (node as Record<string, unknown>)['level']
  return node
}

describe('F-3 · audit redaction stops at max depth', () => {
  it('does not emit a secret nested past the depth limit', () => {
    const payload = nest(8, { password: 'hunter2' })
    const out = redactSensitive(payload)
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('marks the truncation instead of returning the raw subtree', () => {
    const out = redactSensitive(nest(8, { password: 'hunter2' }))
    expect(dig(out, 7)).toBe('[truncated]')
  })

  it('still redacts normally within the depth limit', () => {
    const out = redactSensitive({ a: { b: { password: 'hunter2' } } }) as Record<string, never>
    expect(JSON.stringify(out)).toContain('[redacted]')
    expect(JSON.stringify(out)).not.toContain('hunter2')
  })

  it('truncates in the PII-minimizing redactor too', () => {
    const out = redactSensitiveAndPii(nest(8, { email: 'a@b.com' }))
    expect(JSON.stringify(out)).not.toContain('a@b.com')
    expect(dig(out, 7)).toBe('[truncated]')
  })

  it('truncates deep arrays as well', () => {
    const out = redactSensitive(nest(7, { list: [{ token: 'abc' }] }))
    expect(JSON.stringify(out)).not.toContain('abc')
  })
})
