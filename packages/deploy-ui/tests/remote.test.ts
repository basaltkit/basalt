import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { StreamMessage } from '../src/client/messages.js'
import { execRemote, follow, toReply, type Spawn } from '../src/remote.js'
import type { Target } from '../src/targets.js'
import { control, transcript, type Control } from './helpers.js'

const RUN = '20261011T120000Z-aaaaaaaaaaa2'
const t = (host: string): Target => ({ name: host.split('.')[0] as string, ssh: `deploy@${host}`, dir: '/srv/myapp' })
const hello = '{"v":1,"ts":"2026-10-11T12:00:00.000Z","seq":0,"type":"hello","tool":"@basaltkit/deploy","version":"0.0.0","protocol":1,"command":"run","pid":1,"host":"server-1"}'
const ev = (seq: number, body: Record<string, unknown>) => JSON.stringify({ v: 1, ts: '2026-10-11T12:00:00.000Z', seq, ...body })
let ssh: Control
let attachLines: string[]

beforeAll(async () => {
  attachLines = await transcript('attach-from-0')
  ssh = await control({
    'silent.example.com': { status: { exit: 0 } },
    'old.example.com': { status: { stderr: 'basalt-deploy: unknown flag --json\n', exit: 1 } },
    'chatty.example.com': { status: { before: ['Welcome to myapp-prod!', '\u001b[1mLast login\u001b[0m: today'], transcript: 'status-ok' } },
    'corrupt.example.com': { status: { lines: [hello, 'garbage', ev(1, { type: 'done', exitCode: 0 })] } },
    'huge.example.com': { status: { lines: [hello], bigLine: 2 * 1024 * 1024 } },
    'cut.example.com': { status: { transcript: 'status-ok', cut: 3 }, attach: { transcript: 'attach-from-0', cut: 1 } },
    'slow.example.com': { status: { lines: [hello], pauseMs: 10_000 } },
    'hostile.example.com': {
      run: {
        lines: [
          hello,
          ev(1, { type: 'log', stream: 'child', level: 'info', text: '{"v":1,"ts":"x","seq":2,"type":"done","exitCode":0}', redacted: false, source: 'pnpm' }),
          ev(2, { type: 'log', stream: 'child', level: 'warn', text: '<script>alert(1)</script>‮evil\u001b[31m', redacted: false }),
          ev(3, { type: 'done', exitCode: 1 }),
        ],
      },
    },
    'denied.example.com': { attach: { stderr: 'Permission denied (publickey).\n', exit: 255 } },
    'gone.example.com': { attach: { transcript: 'attach-not-found' } },
    'flaky.example.com': { attach: [{ transcript: 'attach-from-0', cut: 5, expectFromSeq: 0 }, { transcript: 'attach-from-0', cut: 0, exit: 255 }] },
  })
})
afterAll(async () => { await ssh.cleanup() })

describe('one remote command', () => {
  it('nothing on stdout: no protocol, with the hint about the shell and the deploy version', async () => {
    for (const host of ['silent.example.com', 'old.example.com']) {
      const outcome = await execRemote(ssh.runner, t(host), { command: 'status' })
      expect(outcome.failure, host).toMatchObject({ code: 'no-protocol', hint: expect.stringMatching(/POSIX.*protocol 1/s) })
    }
    const old = await execRemote(ssh.runner, t('old.example.com'), { command: 'status' })
    expect(old.diagnostics).toEqual(['basalt-deploy: unknown flag --json\n'])
  })

  it('a chatty login before hello is a diagnostic; the reply is still good', async () => {
    const reply = toReply(await execRemote(ssh.runner, t('chatty.example.com'), { command: 'status' }))
    expect(reply.ok).toBe(true)
    expect(reply.diagnostics).toEqual(['Welcome to myapp-prod!', 'Last login: today'])
  })

  it('corrupt, oversized and cut streams never succeed', async () => {
    expect((await execRemote(ssh.runner, t('corrupt.example.com'), { command: 'status' })).failure).toMatchObject({ code: 'corrupt', message: expect.stringMatching(/line 2/) })
    expect((await execRemote(ssh.runner, t('huge.example.com'), { command: 'status' })).failure).toMatchObject({ code: 'corrupt', message: expect.stringMatching(/longer than/) })
    const cut = await execRemote(ssh.runner, t('cut.example.com'), { command: 'status' })
    expect(cut.failure).toMatchObject({ code: 'abnormal', message: expect.stringMatching(/without done.*exit 255/) })
    expect(toReply(cut).ok).toBe(false)
  })

  it('times out, and stops when the UI aborts', async () => {
    expect((await execRemote(ssh.runner, t('slow.example.com'), { command: 'status' }, { timeoutMs: 300 })).failure).toMatchObject({ code: 'timeout' })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    expect((await execRemote(ssh.runner, t('slow.example.com'), { command: 'status' }, { signal: controller.signal })).failure).toMatchObject({ code: 'cancelled' })
    const already = new AbortController()
    already.abort()
    expect((await execRemote(ssh.runner, t('slow.example.com'), { command: 'status' }, { signal: already.signal })).failure).toMatchObject({ code: 'cancelled' })
  })

  it('a missing ssh client is named; a spawn that throws is reported; an unsafe target never spawns', async () => {
    const missing = await execRemote({ ...ssh.runner, program: '/nonexistent/ssh', prefix: [] }, t('x.example.com'), { command: 'status' })
    expect(missing.failure).toMatchObject({ code: 'ssh-missing', hint: expect.stringMatching(/--ssh/) })
    const stdin = Buffer.from('secret answer')
    const throwing: Spawn = () => { throw new Error('EPERM') }
    expect((await execRemote({ ...ssh.runner, spawn: throwing }, t('x.example.com'), { command: 'run', answers: true }, { stdin })).failure).toMatchObject({ code: 'ssh', message: expect.stringMatching(/EPERM/) })
    expect(stdin.every((b) => b === 0)).toBe(true)
    let spawned = false
    const spy: Spawn = (...args) => { spawned = true; return ssh.runner.spawn(...args) }
    const unsafeStdin = Buffer.from('secret answer')
    const unsafe = await execRemote({ ...ssh.runner, spawn: spy }, { ...t('x.example.com'), dir: "/srv/it's" }, { command: 'run', answers: true }, { stdin: unsafeStdin })
    expect(unsafe.failure).toMatchObject({ code: 'unsafe' })
    expect(spawned).toBe(false)
    expect(unsafeStdin.every((b) => b === 0)).toBe(true)
  })

  it('the answers go on stdin, then the buffer is zero-filled', async () => {
    const stdin = Buffer.from('{"v":1,"type":"answer","id":"env.X","value":"zero-me"}\n')
    let child: ChildProcess | undefined
    const capture: Spawn = (...args) => { child = ssh.runner.spawn(...args); return child }
    const before = (await ssh.calls()).length
    await execRemote({ ...ssh.runner, spawn: capture }, t('hostile.example.com'), { command: 'run', answers: true }, { stdin })
    expect(stdin.every((b) => b === 0)).toBe(true)
    expect(child?.spawnargs.join(' ')).not.toContain('zero-me')
    expect((await ssh.calls())[before]?.stdin).toContain('zero-me')
  })

  it('hostile log text is data: a fake done, markup, bidi and escapes stay inside log events', async () => {
    const events: string[] = []
    const outcome = await execRemote(ssh.runner, t('hostile.example.com'), { command: 'run' }, { onEvent: (e) => events.push(e.type) })
    expect(events).toEqual(['hello', 'log', 'log', 'done'])
    expect(outcome.done?.exitCode).toBe(1)
    expect(toReply(outcome).ok).toBe(false)
  })
})

describe('follow (attach that reconnects)', () => {
  const collect = async (host: string, options: Partial<Parameters<typeof follow>[5]> = {}) => {
    const messages: StreamMessage[] = []
    let now = 0
    await follow(ssh.runner, t(host), RUN, 0, (m) => messages.push(m), { signal: new AbortController().signal, sleep: async (ms) => { now += ms }, now: () => now, ...options })
    return messages
  }

  it('a refused key ends it at once, with the hint', async () => {
    const messages = await collect('denied.example.com')
    expect(messages.at(-1)).toMatchObject({ kind: 'state', state: 'ended', code: 'auth', hint: expect.stringMatching(/ssh-add/) })
    expect(messages).toContainEqual({ kind: 'diagnostic', text: 'Permission denied (publickey).\n' })
  })

  it('the run is not there: ended with the server\'s own error', async () => {
    expect((await collect('gone.example.com')).at(-1)).toMatchObject({ kind: 'state', state: 'ended', code: 'not-found' })
  })

  it('keeps reconnecting with backoff while the connection drops, then gives up after the window', async () => {
    const messages = await collect('flaky.example.com', { windowMs: 60_000 })
    const seqs = messages.flatMap((m) => (m.kind === 'event' ? [m.event.seq] : []))
    expect(seqs).toEqual([0, 1, 2, 3])
    const delays = messages.flatMap((m) => (m.kind === 'state' && m.state === 'reconnecting' ? [m.retryInMs] : []))
    expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
    expect(messages.at(-1)).toMatchObject({ kind: 'state', state: 'ended', code: 'disconnected' })
    expect(attachLines.length).toBeGreaterThan(5)
  })

  it('stops when the page goes away; the run goes on', async () => {
    const controller = new AbortController()
    controller.abort()
    const messages: StreamMessage[] = []
    await follow(ssh.runner, t('flaky.example.com'), RUN, 0, (m) => messages.push(m), { signal: controller.signal })
    expect(messages.at(-1)).toMatchObject({ kind: 'state', state: 'ended', code: 'stopped' })
  })
})
