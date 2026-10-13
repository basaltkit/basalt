import { describe, expect, it } from 'vitest'
import type { DeployEvent } from '@basaltkit/deploy/protocol'
import { MAX_DIAGNOSTIC_BYTES, MAX_LINE_BYTES, ProtocolReader, sanitizeText } from '../src/stream.js'
import { transcript } from './helpers.js'

const ev = (seq: number, body: Record<string, unknown>) => JSON.stringify({ v: 1, ts: '2026-10-11T12:00:00.000Z', seq, ...body })
const hello = ev(0, { type: 'hello', tool: '@basaltkit/deploy', version: '0.0.0', protocol: 1, command: 'status', pid: 1, host: 'server-1' })
const log = (seq: number, text: string) => ev(seq, { type: 'log', stream: 'child', level: 'info', text, redacted: false })
const done = (seq: number, exitCode = 0) => ev(seq, { type: 'done', exitCode })

function read(chunks: Array<string | Buffer>, options: ConstructorParameters<typeof ProtocolReader>[0] = {}) {
  const events: DeployEvent[] = []
  const inner: DeployEvent[] = []
  const reader = new ProtocolReader({ ...options, onEvent: (e) => events.push(e), onInner: (e) => inner.push(e) })
  for (const chunk of chunks) reader.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  reader.end()
  return { reader, events, inner }
}

describe('reading --json output', () => {
  it('a recorded transcript, split at every byte boundary, reads the same', async () => {
    const lines = await transcript('env-answers')
    const whole = Buffer.from(`${lines.join('\n')}\n`)
    const reference = read([whole])
    expect(reference.reader.failure).toBeUndefined()
    expect(reference.reader.done?.exitCode).toBe(0)
    for (const size of [1, 2, 3, 7, 64]) {
      const chunks: Buffer[] = []
      for (let i = 0; i < whole.length; i += size) chunks.push(whole.subarray(i, i + size))
      expect(read(chunks).events).toEqual(reference.events)
    }
  })

  it('multi-byte UTF-8 across chunks', () => {
    const text = Buffer.from(`${hello}\n${log(1, 'déploiement — ✓ 日本')}\n${done(2)}\n`)
    const at = text.indexOf(Buffer.from('日')) + 1
    const { events } = read([text.subarray(0, at), text.subarray(at)])
    expect((events[1] as { text: string }).text).toBe('déploiement — ✓ 日本')
  })

  it('text before hello is foreign: kept as sanitised diagnostics, capped, never parsed', () => {
    const fake = done(0)
    const { reader, events } = read([`Welcome to myapp-prod\n\u001b[31mred motd\u001b[0m\n${fake}\n${hello}\n${done(1)}\n`])
    expect(reader.diagnostics.lines).toEqual(['Welcome to myapp-prod', 'red motd', fake])
    expect(events.map((e) => e.type)).toEqual(['hello', 'done'])
    const flood = read([`${'x'.repeat(1000)}\n`.repeat(100)])
    expect(flood.reader.diagnostics.lines.join('').length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES)
    expect(flood.reader.diagnostics.dropped).toBeGreaterThan(0)
    expect(flood.reader.hello).toBeUndefined()
  })

  it('after hello: a malformed line, a gap, a repeat, a line after done, an oversized line, a cut line — corrupt, never skipped', () => {
    const cases: Array<[string[], RegExp]> = [
      [[hello, 'not json'], /corrupt at line 2: not JSON/],
      [[hello, log(2, 'gap')], /seq 2, expected 1/],
      [[hello, log(1, 'a'), log(1, 'again')], /seq 1, expected 2/],
      [[hello, done(1), log(2, 'late')], /after done/],
      [[hello, ev(1, { type: 'log', stream: 'child', level: 'info', text: 'x' })], /malformed log/],
      [[hello, ev(1, { type: 'event', event: { v: 1, ts: 'x', seq: 0, type: 'event', event: {} } })], /corrupt/],
    ]
    for (const [lines, message] of cases) {
      const { reader } = read([`${lines.join('\n')}\n`])
      expect(reader.failure, lines.join(' | ')).toMatchObject({ kind: 'corrupt', message: expect.stringMatching(message) })
    }
    expect(read([`${hello}\n${'x'.repeat(MAX_LINE_BYTES + 1)}\n`]).reader.failure?.message).toMatch(/longer than/)
    expect(read([`${hello}\n`, Buffer.alloc(MAX_LINE_BYTES + 1, 0x78)]).reader.failure?.message).toMatch(/longer than/)
    expect(read([`${hello}\n${log(1, 'cut')}`]).reader.failure?.message).toMatch(/mid-line/)
    // The reader stops at the first failure.
    const stopped = new ProtocolReader()
    stopped.push(Buffer.from(`${hello}\nbad\n`))
    expect(stopped.push(Buffer.from(`${done(1)}\n`))).toBe(false)
  })

  it('a hello of another protocol is a version mismatch, not foreign text', () => {
    const v2 = JSON.stringify({ v: 2, ts: 'x', seq: 0, type: 'hello', tool: '@basaltkit/deploy', version: '9.0.0', protocol: 2, command: 'status', pid: 1, host: 'h' })
    expect(read([`${v2}\n`]).reader.failure).toMatchObject({ kind: 'protocol-version' })
  })

  it('a fake done printed by a build is a log line; an unknown type passes as unknown', () => {
    const unknown = ev(2, { type: 'telemetry', data: 1 })
    const known: boolean[] = []
    const reader = new ProtocolReader({ onEvent: (_e, k) => known.push(k) })
    reader.push(Buffer.from(`${hello}\n${log(1, '{"v":1,"type":"done","exitCode":0}')}\n${unknown}\n${done(3, 1)}\n`))
    expect(reader.done?.exitCode).toBe(1)
    expect(known).toEqual([true, true, false, true])
  })

  it('attach: the outer and the run\'s sequences are both checked; the run\'s is the resume key', async () => {
    const lines = await transcript('attach-from-10')
    const { reader, inner } = read([`${lines.join('\n')}\n`], { attach: { fromSeq: 10 } })
    expect(reader.failure).toBeUndefined()
    expect(inner[0]?.seq).toBe(10)
    expect(reader.lastInnerSeq).toBe(45)
    expect(reader.innerDone?.exitCode).toBe(0)
    // Starting anywhere else than asked is a gap.
    expect(read([`${lines.join('\n')}\n`], { attach: { fromSeq: 9 } }).reader.failure?.message).toMatch(/not continuous/)
    // A run event dropped from the middle.
    const holed = [...lines.slice(0, 5), ...lines.slice(6).map((l) => { const o = JSON.parse(l); o.seq -= 1; return JSON.stringify(o) })]
    expect(read([`${holed.join('\n')}\n`], { attach: { fromSeq: 10 } }).reader.failure?.message).toMatch(/not continuous/)
  })

  it('sanitises escapes, controls and bidi overrides, keeps tab and newline', () => {
    expect(sanitizeText('a\u001b[31mb\u001b[0m\u001b]0;title\u0007c\u0007d‮evil⁦e‏f\u0085g\th\ni\r\u009b2Jj\u001bk')).toBe('abcdevilefg\th\nijk')
  })
})
