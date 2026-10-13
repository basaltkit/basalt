import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AnswerChannel, askedQuestions } from '../src/answers.js'
import { processIO } from '../src/cli.js'
import { DeployError } from '../src/context.js'
import { eventOutput, EventWriter, humanReporter, isSecretKey, LineSplitter, Redactor, sanitize, truncate, urlPasswords } from '../src/events.js'
import { jsonHost } from '../src/json-host.js'
import * as protocol from '../src/protocol.js'
import { parseAnswerLine, parseEvent, type DeployEvent, type EventBody } from '../src/protocol.js'
import { FakeHost } from './fake-host.js'
import { liveStdin, stdinOf } from './json-helpers.js'

const at = new Date('2026-10-11T12:00:00.000Z')
function writer(options: Partial<ConstructorParameters<typeof EventWriter>[0]> = {}) {
  const lines: string[] = []
  const w = new EventWriter({ now: () => at, stdout: (line) => lines.push(line), redactor: new Redactor(), ...options })
  return { w, lines, events: () => lines.map((l) => JSON.parse(l) as DeployEvent) }
}

/** One of each event type, as a command emits it. */
const BODIES: EventBody[] = [
  { type: 'hello', tool: '@basaltkit/deploy', version: '0.5.0', protocol: 1, command: 'run', pid: 1, host: 'server-1' },
  { type: 'step-start', id: 'build', title: 'build' },
  { type: 'step-end', id: 'build', status: 'ok', durationMs: 12 },
  { type: 'log', stream: 'child', level: 'info', text: 'compiled', redacted: false, step: 'build', source: 'pnpm' },
  { type: 'finding', id: 'C3', level: 'warning', message: 'm', fix: 'f' },
  { type: 'prompt', id: 'env.SMTP_URL', kind: 'secret', message: 'SMTP URL [SMTP_URL]', key: 'SMTP_URL', optional: false, attempt: 1 },
  { type: 'result', command: 'cancel', data: { runId: '20261011T120000Z-0123456789ab', pid: 2, signal: 'SIGTERM', second: false } },
  { type: 'error', code: 'preflight', message: 'preflight: 1 problem(s)', findings: [{ id: 'git', level: 'error', message: 'dirty' }] },
  { type: 'done', exitCode: 0 },
]

describe('the event schema (v1)', () => {
  it('every type round-trips through the writer and parseEvent', () => {
    const { w, lines } = writer({ runId: '20261011T120000Z-0123456789ab' })
    for (const body of BODIES) w.emit(body)
    w.emit({ type: 'event', event: JSON.parse(lines[0] as string) as DeployEvent })
    expect(lines).toHaveLength(BODIES.length + 1)
    lines.forEach((line, seq) => {
      const parsed = parseEvent(line)
      expect(parsed.ok, line).toBe(true)
      expect(parsed.known).toBe(true)
      expect(parsed.ok && parsed.value).toMatchObject({ v: 1, seq, ts: at.toISOString(), runId: '20261011T120000Z-0123456789ab' })
    })
    expect(protocol.EVENT_TYPES).toEqual([...BODIES.map((b) => b.type), 'event'])
  })

  it('refuses what is not an event; skips a type it does not know (additive within v1)', () => {
    const base = { v: 1, ts: 'x', seq: 0 }
    const bad: unknown[] = [
      'nope', [], { ...base, v: 2, type: 'done', exitCode: 0 }, { ...base, type: 'done' }, { v: 1, seq: 0, type: 'done', exitCode: 0 },
      { ...base, seq: -1, type: 'done', exitCode: 0 }, { ...base, seq: 1.5, type: 'done', exitCode: 0 }, { ...base, runId: '../x', type: 'done', exitCode: 0 },
      { ...base, type: 'step-start', id: 'deploy-everything', title: 't' }, { ...base, type: 'error', code: 'oops', message: 'm' },
      { ...base, type: 'prompt', id: 'env.X', kind: 'secret', message: 'm', optional: false, attempt: 1, default: 'leak' },
      { ...base, type: 'log', stream: 'child', level: 'info', text: 'x' }, { ...base, type: 'hello', tool: 'other' },
      { ...base, type: 'done', exitCode: 0, redacted: false }, { ...base, type: 'event', event: { ...base, type: 'event', event: {} } },
      { type: 'done', exitCode: 0, v: 1, ts: 'x', seq: 0, redacted: 'yes' },
    ]
    for (const value of bad) expect(parseEvent(JSON.stringify(value)).ok, JSON.stringify(value)).toBe(false)
    expect(parseEvent('{not json').ok).toBe(false)
    const future = parseEvent(JSON.stringify({ ...base, type: 'progress', percent: 50 }))
    expect(future).toMatchObject({ ok: true, known: false })
    expect(protocol.isStepId('lock')).toBe(true)
    expect(protocol.isErrorCode('locked')).toBe(true)
  })

  it('answer lines: strict, and an error never quotes the value', () => {
    expect(parseAnswerLine('{"v":1,"type":"answer","id":"env.A_B","value":"x","extra":1}')).toEqual({ ok: true, value: { v: 1, type: 'answer', id: 'env.A_B', value: 'x' } })
    for (const [line, error] of [
      ['[]', /not a JSON object/], ['x', /not JSON/], ['{"v":2,"type":"answer","id":"env.A","value":"s3cret-v"}', /v 2/],
      ['{"type":"answer","id":"env.A","value":"s3cret-v"}', /v missing/], ['{"v":1,"type":"ask","id":"env.A","value":"s3cret-v"}', /type/],
      ['{"v":1,"type":"answer","id":"env.a","value":"s3cret-v"}', /env\.<KEY>/], ['{"v":1,"type":"answer","id":"env.A","value":7}', /not a string/],
      ['{"v":1,"type":"answer","id":"env.A","value":"s3cret-v\\u0000"}', /NUL/], [`{"v":1,"type":"answer","id":"env.A","value":"${'x'.repeat(70_000)}"}`, /larger than/],
      ['{"v":1,"type":"answer","id":"env.__proto__","value":"s3cret-v"}', /env\.<KEY>/],
    ] as const) {
      const parsed = parseAnswerLine(line)
      expect(parsed.ok).toBe(false)
      expect(!parsed.ok && parsed.error).toMatch(error)
      expect(!parsed.ok && parsed.error).not.toContain('s3cret-v')
    }
  })
})

describe('the writer', () => {
  it('redacts every string before serialising — a secret JSON would escape too — and marks the event', () => {
    const redactor = new Redactor()
    redactor.add('TOKEN', 'p"ss\\w0rd')
    const { w, lines, events } = writer({ redactor })
    w.emit({ type: 'error', code: 'failed', message: 'git fetch failed: p"ss\\w0rd', findings: [{ id: 'x', level: 'error', message: 'also p"ss\\w0rd' }] })
    w.emit({ type: 'log', stream: 'tool', level: 'info', text: 'clean', redacted: false })
    expect(lines.join('')).not.toContain('ss\\\\w0rd')
    expect(events()[0]).toMatchObject({ redacted: true, message: 'git fetch failed: [redacted:TOKEN]', findings: [{ message: 'also [redacted:TOKEN]' }] })
    expect(events()[1]).toMatchObject({ redacted: false })
    expect(events()[1]).not.toHaveProperty('runId')
  })

  it('keeps the events for the run log until it is attached, then writes them first; drops them when there is none', () => {
    const appended: string[] = []
    const { w, lines } = writer({ expectRunLog: true })
    w.emit(BODIES[0] as EventBody)
    w.attachLog({ append: (t) => appended.push(t), close: () => undefined })
    w.emit(BODIES[8] as EventBody)
    expect(appended).toEqual(lines)
    const other = writer({ expectRunLog: true })
    other.w.emit(BODIES[0] as EventBody)
    other.w.dropBacklog()
    other.w.emit(BODIES[8] as EventBody)
    expect(other.lines).toHaveLength(2)
  })

  it('caps log lines in the run log: one notice, no seq taken, every other event kept', () => {
    const appended: string[] = []
    const { w, events } = writer({ cap: 600 })
    w.attachLog({ append: (t) => appended.push(t), close: () => undefined })
    for (let i = 0; i < 10; i++) w.emit({ type: 'log', stream: 'child', level: 'info', text: `line ${i} ${'x'.repeat(60)}`, redacted: false })
    w.emit({ type: 'done', exitCode: 0 })
    const all = events()
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i))
    expect(all.filter((e) => e.type === 'log' && e.text.startsWith('run log cap reached'))).toHaveLength(1)
    expect(all.at(-1)).toMatchObject({ type: 'done' })
    expect(appended.join('')).toBe(all.map((e) => `${JSON.stringify(e)}\n`).join(''))
  })

  it('a run log that fails stops being written; stdout keeps every event; one plain line on stderr', () => {
    const failures: string[] = []
    const { w, lines } = writer({ onFailure: (m) => failures.push(m) })
    w.attachLog({ append: () => { throw new Error('ENOSPC') }, close: () => { throw new Error('gone') } })
    w.emit(BODIES[0] as EventBody)
    w.emit(BODIES[8] as EventBody)
    w.close()
    expect(lines).toHaveLength(2)
    expect(failures).toEqual(['basalt-deploy: the run log could not be written: ENOSPC'])
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    w.emit({ type: 'result', command: 'status', data: cyclic } as unknown as EventBody)
    expect(failures[1]).toMatch(/an event could not be written/)
    expect(lines).toHaveLength(2)
  })

  it('a reader gone (EPIPE) never fails the command, and the run log still gets everything', () => {
    const stream = new Writable({ write(_chunk, _enc, done) { done() } })
    let calls = 0
    stream.write = (() => { calls++; const e = new Error('write EPIPE') as NodeJS.ErrnoException; e.code = 'EPIPE'; throw e }) as typeof stream.write
    const io = processIO(stream as unknown as NodeJS.WritableStream, stdinOf())
    const appended: string[] = []
    const w = new EventWriter({ now: () => at, stdout: (l) => io.write(l), redactor: new Redactor() })
    w.attachLog({ append: (t) => appended.push(t), close: () => undefined })
    for (const body of BODIES) w.emit(body)
    expect(calls).toBe(1)
    expect(appended).toHaveLength(BODIES.length)
    // An asynchronous EPIPE is an 'error' event: heard, not thrown.
    const later = new Writable({ write(_chunk, _enc, done) { done() } })
    const io2 = processIO(later as unknown as NodeJS.WritableStream)
    later.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))
    io2.write('ignored\n')
    const other = new Writable({ write(_c, _e, done) { done() } })
    other.write = (() => { throw new Error('EBADF') }) as typeof other.write
    expect(() => processIO(other as unknown as NodeJS.WritableStream).write('x')).toThrow('EBADF')
  })
})

describe('the redactor', () => {
  it('replaces raw and URL-encoded values, longest first; ignores values shorter than 6, naming them', () => {
    const r = new Redactor()
    expect(r.add('A', 'abcdef')).toBe('added')
    expect(r.add('B', 'abcdefgh')).toBe('added')
    expect(r.add('C', 'p@ss w/rd!')).toBe('added')
    expect(r.add('D', 'tiny')).toBe('short')
    expect(r.add('D', 'tiny')).toBe('known')
    expect(r.add('E', '')).toBe('empty')
    expect(r.add('A', 'abcdef')).toBe('known')
    expect(r.short).toEqual(new Set(['D']))
    expect(r.apply('abcdefgh abcdef tiny p%40ss%20w%2Frd! p@ss w/rd!')).toEqual({ text: '[redacted:B] [redacted:A] tiny [redacted:C] [redacted:C]', hit: true })
    expect(r.apply('short')).toEqual({ text: 'short', hit: false })
    expect(new Redactor().apply('anything at all')).toEqual({ text: 'anything at all', hit: false })
  })

  it('knows secret keys by config and by name; finds passwords in URLs', () => {
    const config = { env: { generate: { SESSION: { kind: 'secret', bytes: 32 } }, ask: { SMTP: { secret: true }, NAME: { secret: false } } } } as unknown as Parameters<typeof isSecretKey>[1]
    expect(['SESSION', 'SMTP', 'API_TOKEN', 'DATABASE_URL', 'BASALT_MINIO_USER', 'PGPASSWORD'].every((k) => isSecretKey(k, config))).toBe(true)
    expect(['NAME', 'PORT', 'HOST'].some((k) => isSecretKey(k, config))).toBe(false)
    expect(isSecretKey('NAME')).toBe(false)
    expect(urlPasswords('postgresql://u:p%40ss@h/db')).toEqual(['p%40ss', 'p@ss'])
    expect(urlPasswords('redis://:only@h:6379')).toEqual(['only'])
    expect(urlPasswords('https://example.com/a:b@c')).toEqual([])
    expect(urlPasswords('smtp://u:%E0%A4%A@h')).toEqual(['%E0%A4%A'])
  })
})

describe('text from outside', () => {
  it('sanitises escapes and control characters, keeps tabs (and newlines when asked)', () => {
    expect(sanitize('\u001b[31mred\u001b[0m\ttab\u0007\u0000\u009b1m\u001b]0;title\u0007end\u001bPdcs\u001b\\\u001bc')).toBe('red\ttabend')
    expect(sanitize('a\nb\r', true)).toBe('a\nb')
    expect(sanitize('a\nb')).toBe('ab')
  })

  it('cuts at 8 KiB of UTF-8, never half a character', () => {
    expect(truncate('short')).toEqual({ text: 'short', truncated: false })
    const cut = truncate('é'.repeat(5000))
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe('é'.repeat(4096))
    expect(truncate('a' + 'é'.repeat(5000)).text).toBe('a' + 'é'.repeat(4095))
  })

  it('splits on \\n, \\r\\n and a lone \\r, across chunks; bounds a line without an end', () => {
    const s = new LineSplitter(10)
    expect(s.push('a\r')).toEqual([])
    expect(s.push('\nb\rc')).toEqual(['a', 'b'])
    expect(s.push('defghijklmnop')).toEqual(['cdefghijkl'])
    expect(s.end()).toEqual(['mnop'])
    expect(s.end()).toEqual([])
  })

  it('the human renderer prints what the terminal always did, and nothing for the protocol-only events', () => {
    const host = new FakeHost()
    const human = humanReporter(host.out)
    for (const body of BODIES) human.emit(body)
    human.emit({ type: 'finding', id: 'C1', level: 'error', message: 'bad' })
    expect(host.printed).toEqual(['STEP build', 'INFO compiled', 'WARN [C3] m\n      → f', 'ERROR preflight: 1 problem(s)', 'ERROR [C1] bad'])
  })

  it('the event output: a title that is not a step id is a log line; the current step follows step-end', () => {
    const { w, events } = writer()
    const out = eventOutput(w)
    out.step('acme — last 2 release(s)')
    out.step('release abcdef0', 'release')
    expect(out.current).toBe('release')
    out.warn('careful')
    out.stepEnd('release', 'ok', 3.6)
    out.stepEnd('build', 'ok', -1)
    out.info('after')
    expect(events().map((e) => [e.type, 'step' in e ? e.step : undefined])).toEqual([['log', undefined], ['step-start', undefined], ['log', 'release'], ['step-end', undefined], ['step-end', undefined], ['log', undefined]])
    expect(events()[3]).toMatchObject({ durationMs: 4 })
    expect(events()[4]).toMatchObject({ durationMs: 0 })
  })
})

describe('the answer channel', () => {
  const questions = askedQuestions({ TOKEN: { secret: true }, NAME: { secret: false }, NONE: undefined })
  const line = (id: string, value: string) => JSON.stringify({ v: 1, type: 'answer', id, value })

  it('holds answers until asked; a secret is learnt the moment it is parsed; leftovers are named at the end', async () => {
    const secrets: string[] = []
    const channel = new AnswerChannel(questions, (key, value) => secrets.push(`${key}=${value}`))
    channel.start(stdinOf([line('env.TOKEN', 'tok-123456'), '', line('env.NAME', 'myapp')]))
    await channel.drain()
    expect(secrets).toEqual(['TOKEN=tok-123456'])
    expect(channel.peek('env.TOKEN')).toBe('tok-123456')
    expect(channel.serialize()).toBe(`${line('env.TOKEN', 'tok-123456')}\n${line('env.NAME', 'myapp')}\n`)
    expect(await channel.take('env.TOKEN', 1000)).toBe('tok-123456')
    expect(await channel.take('env.TOKEN', 1000)).toBeUndefined()
    expect(channel.live).toBe(false)
    expect(channel.finish()).toEqual(['NAME'])
  })

  it('bytes split across chunks, a last line without its newline, CRLF', async () => {
    const channel = new AnswerChannel(questions, () => undefined)
    const encoded = Buffer.from(`${line('env.NAME', 'é-name')}\r\n${line('env.TOKEN', 'tok-abcdef')}`)
    channel.start((async function* () { yield encoded.subarray(0, 50); yield encoded.subarray(50) })())
    await channel.drain()
    expect(await channel.take('env.NAME', 10)).toBe('é-name')
    expect(await channel.take('env.TOKEN', 10)).toBe('tok-abcdef')
  })

  it('live: waits for an answer, allows one more after a refusal, times out, wakes on EOF', async () => {
    const live = liveStdin()
    const channel = new AnswerChannel(questions, () => undefined)
    channel.start(live.source)
    await channel.settle(5)
    const waiting = channel.take('env.NAME', 5000)
    live.send(line('env.NAME', 'first'))
    expect(await waiting).toBe('first')
    channel.expectAgain('env.NAME')
    const again = channel.take('env.NAME', 5000)
    live.send(line('env.NAME', 'second'))
    expect(await again).toBe('second')
    await expect(channel.take('env.TOKEN', 20)).rejects.toMatchObject({ code: 'answer-timeout' })
    const eof = channel.take('env.TOKEN', 5000)
    live.close()
    expect(await eof).toBeUndefined()
    expect(channel.live).toBe(false)
  })

  it('a bad line fails every waiter and every later call; a read error is a protocol error', async () => {
    const live = liveStdin()
    const channel = new AnswerChannel(questions, () => undefined)
    channel.start(live.source)
    const waiting = channel.take('env.TOKEN', 5000)
    live.send(line('env.NAME', 'a'))
    live.send(line('env.NAME', 'b'))
    await expect(waiting).rejects.toMatchObject({ code: 'protocol', message: 'two answers for NAME' })
    expect(() => channel.throwIfFatal()).toThrow(DeployError)
    live.close()

    const broken = new AnswerChannel(questions, () => undefined)
    broken.start((async function* () { yield 'x'; throw new Error('EIO') })())
    await expect(broken.drain()).rejects.toMatchObject({ code: 'protocol', message: 'stdin could not be read: EIO' })

    const huge = new AnswerChannel(questions, () => undefined)
    huge.start((async function* () { yield 'x'.repeat(70_000) })())
    await expect(huge.drain()).rejects.toMatchObject({ code: 'protocol' })
  })
})

describe('the JSON host', () => {
  it('refuses an interactive child; a confirm is never assumed; a prompt with no channel or no id is unanswered', async () => {
    const base = new FakeHost()
    const { w, events } = writer()
    const json = jsonHost(base, w, new Redactor())
    await expect(json.host.exec('bash', [], { interactive: true })).rejects.toMatchObject({ code: 'unsupported' })
    expect(await json.host.confirm('reload apache?')).toBe(false)
    expect(events()[0]).toMatchObject({ type: 'prompt', kind: 'confirm', id: 'confirm' })
    expect(await json.host.prompt('q', { secret: false })).toBeUndefined()
    expect(json.host.interactive()).toBe(false)
    // Everything else is the real host's, called on it.
    expect(json.host.pid()).toBe(4100)
    expect(json.host.randomHex(2)).toBe('aaa1')
    expect(base.randomHex(2)).toBe('aaa2')
  })
})
