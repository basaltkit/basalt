import { describe, expect, it } from 'vitest'
import { encodeSseEvent } from '../src/index.js'

// Hand-rolled property/fuzz test: no fast-check dependency. We hammer the encoder
// with adversarial inputs (control chars, forged field prefixes) and assert the
// injection invariants hold for EVERY input.
const CHARS = ['a', 'Z', '0', ' ', '\n', '\r', '\0', ':', 'event: x', 'data: y', 'id: z', 'é', '"', '\\']
const rand = (n: number) => CHARS[Math.floor(Math.random() * CHARS.length)]!.repeat(1 + (n % 3))
const KNOWN = /^(event|id|data|retry): /

describe('encodeSseEvent — injection-resistance (fuzz)', () => {
  it('never lets any input forge an extra SSE field or event across 2000 cases', () => {
    for (let i = 0; i < 2000; i++) {
      const event = {
        data: Array.from({ length: i % 5 }, (_, k) => rand(i + k)).join(''),
        event: i % 3 ? rand(i) : undefined,
        id: i % 2 ? rand(i * 2) : undefined,
      }
      const frame = encodeSseEvent(event)
      expect(frame.endsWith('\n\n')).toBe(true)
      const body = frame.slice(0, -2)
      const lines = body.split('\n')
      // Invariant 1: at most one `event:` and one `id:` line — no injected duplicates.
      expect(lines.filter((l) => l.startsWith('event: ')).length).toBeLessThanOrEqual(1)
      expect(lines.filter((l) => l.startsWith('id: ')).length).toBeLessThanOrEqual(1)
      // Invariant 2: every non-empty line is a KNOWN field (data/event/id/retry) —
      // nothing the attacker smuggled via \n/\r appears as its own field line.
      for (const line of lines) {
        expect(line === '' || KNOWN.test(line)).toBe(true)
      }
      // Invariant 3: no raw CR — CR is a line terminator and would desync the
      // client. (NUL is spec-legal inside a data field, so it is not checked.)
      expect(frame.includes('\r')).toBe(false)
      // event/id fields never carry a NUL (sseField strips it) even if data may.
      for (const l of lines.filter((x) => x.startsWith('event: ') || x.startsWith('id: '))) {
        expect(l.includes('\0')).toBe(false)
      }
    }
  })
})
