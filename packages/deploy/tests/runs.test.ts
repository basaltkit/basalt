import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, type CliIO } from '../src/cli.js'
import { DETACHED_CHILD_ENV } from '../src/detach.js'
import { lockFile } from '../src/lock.js'
import type { DeployEvent } from '../src/protocol.js'
import { KEEP_RUN_LOGS, pruneRunLogs, runLogPath } from '../src/runs.js'
import { readReleases } from '../src/state.js'
import { context, FakeHost } from './fake-host.js'
import { GOOD_ENV, NEW, server } from './acme-server.js'
import { ACME_CONFIG, answer, expectFramed, ofType, runJson, stdinOf } from './json-helpers.js'

let dir: string
const CONFIG = '--config=deploy.config.mjs'
const COMPLETE_ENV = `${GOOD_ENV}SUPPORT_EMAIL=help@example.com\n`
const BARE_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nMAILER_URL=\n'
const RUN = '20261011T120000Z-0123456789ab'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-runs-'))
  await writeFile(join(dir, 'deploy.config.mjs'), ACME_CONFIG)
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const state = () => `${dir}/.basalt`
const line = (event: Record<string, unknown>) => `${JSON.stringify({ v: 1, ts: '2026-10-11T12:00:00.000Z', ...event })}\n`
/** A run log as a run writes it. */
function runLog(events: Array<Record<string, unknown>>, runId = RUN): string {
  return events.map((e, seq) => line({ seq, runId, ...e })).join('')
}
const hello = { type: 'hello', tool: '@basaltkit/deploy', version: '0.0.0', protocol: 1, command: 'run', pid: 5100, host: 'server-1', detached: true }
const lockStep = [{ type: 'step-start', id: 'lock', title: 'lock' }, { type: 'step-end', id: 'lock', status: 'ok', durationMs: 0 }]
const holder = (runId: string, pid = 5100) => JSON.stringify({ pid, host: 'server-1', startedAt: '2026-10-11T12:00:00.000Z', actor: 'deployer', command: 'run', runId })

/** A FakeHost whose sleep lets other work (a detached child) run, like a real clock would. */
function patient(host: FakeHost): FakeHost {
  host.sleep = async (ms) => { host.clock += ms; await new Promise((r) => setTimeout(r, 1)) }
  return host
}

/** The detached child, run in-process on the same server: another process (pid 5100), the marker in its env. */
function childOf(parent: FakeHost, done: (code: Promise<number>) => void): FakeHost['onDetached'] {
  return (call) => {
    const child = new FakeHost()
    child.files = parent.files
    child.handlers = parent.handlers
    child.http = parent.http
    child.certificates = parent.certificates
    child.alive = parent.alive
    child.env = { ...call.env }
    child.processId = 5100
    child.alive.add(5100)
    const io: CliIO = {
      write: (text) => call.stdout.append(text),
      stdin: () => stdinOf(call.stdin.split('\n').filter(Boolean)),
      capture: () => () => undefined,
      stderr: () => undefined,
    }
    expect(call.args[0]).toMatch(/bin\.js$/)
    done(main(call.args.slice(1), child, call.cwd, io).finally(() => child.alive.delete(5100)))
    return 5100
  }
}

describe('run --detach', () => {
  it('starts the run in its own session, the answers on its stdin only; returns once the child holds the lock', async () => {
    const { host, head } = server({ dir, env: BARE_ENV })
    patient(host)
    host.env['SSH_CONNECTION'] = '192.0.2.10 50000 192.0.2.1 22'
    let child: Promise<number> | undefined
    let heldBy: string | undefined
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install') heldBy = host.file(lockFile(state()))
      return undefined
    })
    host.onDetached = childOf(host, (code) => { child = code })
    const secret = 'sk_live_DETACHED_7f3a'
    const parent = await runJson(['run', '--json=1', '--detach', CONFIG, '--answers=stdin', '--via=ui', '--actor=ops-ui'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', secret)]))
    expectFramed(parent)
    expect(parent.code).toBe(0)
    expect(parent.events[0]).toMatchObject({ type: 'hello', detached: true })
    const data = ofType(parent.events, 'result')[0]?.data as { runId: string; pid: number; log: string }
    expect(data.pid).toBe(5100)
    expect(data.log).toBe(runLogPath(state(), data.runId))
    // The parent never took the lock; nothing secret on the child's argv or environment.
    const [call] = host.detached
    expect(call?.command).toBe(process.execPath)
    expect(call?.args.slice(1)).toEqual(['run', '--json=1', `--run-id=${data.runId}`, '--actor=ops-ui', '--via=ui', `${CONFIG}`, '--answers=stdin'])
    expect(call?.env[DETACHED_CHILD_ENV]).toBe('1')
    expect(JSON.stringify([call?.args, call?.env])).not.toContain(secret)
    expect(call?.stdin).toBe(`${answer('PAYCO_SECRET_TOKEN', secret)}\n`)
    expect(parent.raw).not.toContain(secret)

    expect(await child).toBe(0)
    expect(head()).toBe(NEW)
    expect(JSON.parse(heldBy as string)).toMatchObject({ pid: 5100, runId: data.runId })
    const log = host.file(data.log) as string
    expect(log).not.toContain(secret)
    expect(host.mode(data.log)).toBe(0o600)
    const lines = log.trim().split('\n').map((l) => JSON.parse(l) as DeployEvent)
    expect(lines[0]).toMatchObject({ type: 'hello', detached: true, runId: data.runId, seq: 0 })
    expect(lines.at(-1)).toMatchObject({ type: 'done', exitCode: 0 })
    expect(host.file(`${dir}/.env`)).toContain(`PAYCO_SECRET_TOKEN=${secret}`)
    expect((await readReleases(context(host, undefined, dir)))[0]).toMatchObject({ via: 'ui', actor: 'ops-ui', client: '192.0.2.10' })

    // attach replays it, wrapped, from any seq, and ends with the run's exit code.
    const all = await runJson(['attach', data.runId, '--json', CONFIG], host, dir)
    expectFramed(all)
    expect(all.code).toBe(0)
    const wrapped = ofType(all.events, 'event')
    expect(wrapped.map((e) => e.event.seq)).toEqual(lines.map((_, i) => i))
    expect(wrapped.map((e) => e.event)).toEqual(lines)
    const tail = await runJson(['attach', data.runId, '--json', `--from-seq=${lines.length - 2}`, CONFIG], host, dir)
    expect(ofType(tail.events, 'event').map((e) => e.event.seq)).toEqual([lines.length - 2, lines.length - 1])
  })

  it('refuses before starting anything: a missing or invalid answer, a held lock, a host without spawn', async () => {
    const missing = server({ dir, env: BARE_ENV }).host
    const noAnswer = await runJson(['run', '--json', '--detach', CONFIG], missing, dir)
    expectFramed(noAnswer)
    expect(ofType(noAnswer.events, 'error')[0]).toMatchObject({ code: 'answer-missing', message: expect.stringContaining('PAYCO_SECRET_TOKEN') })
    expect(missing.detached).toEqual([])
    expect([...missing.files.keys()].some((p) => p.includes('/runs/'))).toBe(false)

    const invalid = await runJson(['run', '--json', '--detach', CONFIG, '--answers=stdin'], missing, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', '')]))
    expect(ofType(invalid.events, 'error')[0]).toMatchObject({ code: 'answer-invalid' })
    const unknown = await runJson(['run', '--json', '--detach', CONFIG, '--answers=stdin'], missing, dir, stdinOf([answer('NOPE', 'x')]))
    expect(ofType(unknown.events, 'error')[0]).toMatchObject({ code: 'answer-unknown' })
    expect(missing.detached).toEqual([])

    const locked = server({ dir, env: COMPLETE_ENV }).host
    locked.alive.add(777)
    locked.put(lockFile(state()), holder(RUN, 777), 0o600)
    const busy = await runJson(['run', '--json', '--detach', CONFIG], locked, dir)
    expect(busy.code).toBe(3)
    expect(ofType(busy.events, 'error')[0]).toMatchObject({ code: 'locked', holder: { pid: 777, runId: RUN } })
    expect(locked.detached).toEqual([])

    const bare = server({ dir, env: COMPLETE_ENV }).host
    Object.defineProperty(bare, 'spawnDetached', { value: undefined })
    expect(ofType((await runJson(['run', '--json', '--detach', CONFIG], bare, dir)).events, 'error')[0]).toMatchObject({ code: 'unsupported' })
  })

  it('relays the child\'s own refusal (locked, exit 3), and says detach-unconfirmed when the child never confirms', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.onDetached = (call) => {
      call.stdout.append(runLog([hello, { type: 'step-start', id: 'lock', title: 'lock' }, { type: 'step-end', id: 'lock', status: 'failed', durationMs: 1 },
        { type: 'error', code: 'locked', message: 'another deploy is running', holder: { pid: 1, host: 'server-1', startedAt: '', actor: 'x', command: 'run' } }, { type: 'done', exitCode: 3 }],
      (call.args.find((a) => a.startsWith('--run-id=')) as string).slice('--run-id='.length)))
    }
    const relayed = await runJson(['run', '--json', '--detach', CONFIG], host, dir)
    expectFramed(relayed)
    expect(relayed.code).toBe(3)
    expect(ofType(relayed.events, 'error')).toEqual([expect.objectContaining({ code: 'locked', message: 'another deploy is running' })])

    const silent = server({ dir, env: COMPLETE_ENV }).host
    const unconfirmed = await runJson(['rollback', '--json', '--detach', CONFIG], silent, dir)
    expectFramed(unconfirmed)
    expect(unconfirmed.code).toBe(1)
    const error = ofType(unconfirmed.events, 'error')[0]
    expect(error?.code).toBe('detach-unconfirmed')
    expect(error?.hint).toMatch(/^attach \d{8}T\d{6}Z-[0-9a-f]{12}$/)
    expect(silent.detached[0]?.args.slice(1, 3)).toEqual(['rollback', '--json=1'])
    expect(silent.closedLogs).toHaveLength(1)
  })

  it('the runs directory must be the deploy user\'s own 0700 directory, never a link', async () => {
    for (const [setup, why] of [
      [(h: FakeHost) => { h.files.set(`${dir}/.basalt/runs`, { kind: 'symlink', target: '/tmp/elsewhere' }) }, /symbolic link/],
      [(h: FakeHost) => { h.dir(`${dir}/.basalt/runs`, 0o700, { uid: 0 }) }, /owned by uid 0/],
      [(h: FakeHost) => { h.dir(`${dir}/.basalt/runs`, 0o755) }, /other users could read the run logs/],
    ] as const) {
      const { host } = server({ dir, env: COMPLETE_ENV })
      setup(host)
      const result = await runJson(['run', '--json', CONFIG], host, dir)
      expectFramed(result)
      expect(ofType(result.events, 'error')[0]).toMatchObject({ code: 'failed', message: expect.stringMatching(why) })
      expect(host.commands('git')).toEqual([])
    }
    // A log already there (planted) is never reused or followed.
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.dir(`${dir}/.basalt`, 0o700).dir(`${dir}/.basalt/runs`, 0o700)
    host.put(runLogPath(state(), '20261011T120000Z-aaaaaaaaaaa1'), 'planted', 0o600)
    const planted = await runJson(['run', '--json', CONFIG], host, dir)
    expect(ofType(planted.events, 'error')[0]).toMatchObject({ code: 'failed', message: expect.stringMatching(/something is already there/) })
    expect(host.file(runLogPath(state(), '20261011T120000Z-aaaaaaaaaaa1'))).toBe('planted')
  })
})

describe('attach', () => {
  const put = (host: FakeHost, text: string, mode = 0o600, runId = RUN) => host.dir(`${dir}/.basalt/runs`, 0o700).put(runLogPath(state(), runId), text, mode)
  const host = () => server({ dir, env: COMPLETE_ENV }).host

  it('refuses a corrupt line, a seq gap, a link, a log others can read, a missing run, a malformed id', async () => {
    const cases: Array<[(h: FakeHost) => void, string, RegExp]> = [
      [(h) => put(h, `${runLog([hello])}not json\n`), 'failed', /corrupt at line 2: not JSON/],
      [(h) => put(h, runLog([hello]) + line({ seq: 2, runId: RUN, type: 'done', exitCode: 0 })), 'failed', /seq 2 after 0/],
      [(h) => put(h, line({ seq: 0, runId: RUN, type: 'log', stream: 'child', level: 'info', text: 'x' })), 'failed', /malformed log/],
      [(h) => { h.dir(`${dir}/.basalt/runs`, 0o700); h.files.set(runLogPath(state(), RUN), { kind: 'symlink', target: '/etc/passwd' }) }, 'failed', /not a run log this deploy wrote/],
      [(h) => put(h, runLog([hello, { type: 'done', exitCode: 0 }]), 0o644), 'failed', /mode 644/],
      [(h) => put(h, runLog([hello]), 0o600), 'run-vanished', /ended without its last event/],
      [() => undefined, 'not-found', /no run/],
    ]
    for (const [setup, code, message] of cases) {
      const h = host()
      setup(h)
      const result = await runJson(['attach', RUN, '--json', CONFIG], h, dir)
      expectFramed(result)
      expect(result.code).toBe(1)
      expect(ofType(result.events, 'error')[0]).toMatchObject({ code, message: expect.stringMatching(message) })
    }
    const bad = await runJson(['attach', '../../etc/passwd', '--json', CONFIG], host(), dir)
    expect(ofType(bad.events, 'error')[0]?.code).toBe('usage')
  })

  it('--follow waits for the run to end; a run whose process is gone without done is run-vanished', async () => {
    const h = patient(host())
    const path = runLogPath(state(), RUN)
    put(h, runLog([hello, ...lockStep]))
    h.alive.add(5100)
    h.put(lockFile(state()), holder(RUN), 0o600)
    let polls = 0
    const sleep = h.sleep.bind(h)
    h.sleep = async (ms) => {
      if (++polls === 3) {
        // The run goes on writing: the same prefix, two more events.
        h.put(path, runLog([hello, ...lockStep, { type: 'result', command: 'run', data: { sha: NEW } }, { type: 'done', exitCode: 1 }]), 0o600)
      }
      await sleep(ms)
    }
    const followed = await runJson(['attach', RUN, '--json', '--follow', CONFIG], h, dir)
    expectFramed(followed)
    expect(followed.code).toBe(1)
    expect(ofType(followed.events, 'event').map((e) => e.event.type)).toEqual(['hello', 'step-start', 'step-end', 'result', 'done'])
    // The run's exit code, and no error of attach's own: attach itself did not fail.
    expect(ofType(followed.events, 'error')).toEqual([])

    // Without --follow, a live run: the replay so far, exit 0.
    const live = patient(host())
    put(live, runLog([hello, ...lockStep]))
    live.alive.add(5100)
    live.put(lockFile(state()), holder(RUN), 0o600)
    const snapshot = await runJson(['attach', RUN, '--json', CONFIG], live, dir)
    expect(snapshot.code).toBe(0)
    expect(ofType(snapshot.events, 'log').at(-1)?.text).toMatch(/still running/)

    // The run released its lock and writes its last events a moment later: attach waits for them.
    const ending = patient(host())
    const endingPath = runLogPath(state(), RUN)
    put(ending, runLog([hello, ...lockStep]))
    ending.sleep = async (ms) => {
      ending.put(endingPath, runLog([hello, ...lockStep, { type: 'error', code: 'release-failed', message: 'm' }, { type: 'done', exitCode: 1 }]), 0o600)
      ending.clock += ms
    }
    const ended = await runJson(['attach', RUN, '--json', CONFIG], ending, dir)
    expectFramed(ended)
    expect(ended.code).toBe(1)
    expect(ofType(ended.events, 'event').map((e) => e.event.type)).toEqual(['hello', 'step-start', 'step-end', 'error', 'done'])

    // The holder is gone (a second signal, SIGKILL): 2 s later, run-vanished.
    live.alive.delete(5100)
    const gone = await runJson(['attach', RUN, '--json', '--follow', CONFIG], live, dir)
    expect(ofType(gone.events, 'error')[0]).toMatchObject({ code: 'run-vanished' })
    expect(ofType(gone.events, 'event')).toHaveLength(3)
  })
})

describe('cancel', () => {
  const running = () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.alive.add(5100)
    host.put(lockFile(state()), holder(RUN), 0o600)
    host.cmdlines.set(5100, [process.execPath, '/srv/myapp/node_modules/@basaltkit/deploy/dist/bin.js', 'run', '--json=1', `--run-id=${RUN}`])
    return host
  }

  it('signals only the live holder of that run, once — a second cancel is the second signal', async () => {
    const host = running()
    const first = await runJson(['cancel', RUN, '--json', CONFIG], host, dir)
    expectFramed(first)
    expect(ofType(first.events, 'result')[0]?.data).toEqual({ runId: RUN, pid: 5100, signal: 'SIGTERM', second: false })
    const second = await runJson(['cancel', RUN, '--json', CONFIG], host, dir)
    expect(ofType(second.events, 'result')[0]?.data).toMatchObject({ second: true })
    expect(host.killed).toEqual([{ pid: 5100, signal: 'SIGTERM' }, { pid: 5100, signal: 'SIGTERM' }])
    // Human mode says it too.
    const human = running()
    expect(await main(['cancel', RUN, CONFIG], human, dir)).toBe(0)
    expect(human.printed).toEqual([`OK SIGTERM sent to run ${RUN} (pid 5100) — it stops at the next safe point`])
  })

  it('never signals a recycled pid, another run, a dead holder, or what it cannot identify', async () => {
    const recycled = running()
    recycled.cmdlines.set(5100, ['/usr/sbin/nginx', '-g', 'daemon off;'])
    expect(ofType((await runJson(['cancel', RUN, '--json', CONFIG], recycled, dir)).events, 'error')[0]).toMatchObject({ code: 'not-found' })

    const other = running()
    expect(ofType((await runJson(['cancel', '20261011T120000Z-ffffffffffff', '--json', CONFIG], other, dir)).events, 'error')[0]).toMatchObject({ code: 'not-found' })

    const dead = running()
    dead.alive.delete(5100)
    expect(ofType((await runJson(['cancel', RUN, '--json', CONFIG], dead, dir)).events, 'error')[0]).toMatchObject({ code: 'not-found' })

    const blind = running()
    blind.cmdlines.clear()
    expect(ofType((await runJson(['cancel', RUN, '--json', CONFIG], blind, dir)).events, 'error')[0]).toMatchObject({ code: 'unsupported' })

    for (const host of [recycled, other, dead, blind]) expect(host.killed).toEqual([])
  })
})

describe('retention and status', () => {
  it('keeps the newest 50 and none older than 30 days; never the active run, never another name; unlink only', async () => {
    const host = new FakeHost()
    host.clock = new Date('2026-10-11T12:00:00Z').getTime()
    const runs = `${dir}/.basalt/runs`
    host.dir(runs, 0o700)
    const ids: string[] = []
    for (let i = 0; i < 55; i++) {
      const at = new Date(host.clock - i * 3600 * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
      ids.push(`${at}-${i.toString(16).padStart(12, '0')}`)
    }
    const old = '20260801T000000Z-00000000beef'
    for (const id of [...ids, old]) host.put(`${runs}/${id}.ndjson`, '', 0o600)
    host.put(`${runs}/${old}.cancel`, '', 0o600)
    host.put(`${runs}/notes.txt`, 'mine', 0o600)
    host.dir(`${runs}/20260101T000000Z-000000000000.ndjson`, 0o700)
    const active = ids[54] as string
    const removed = await pruneRunLogs(host, `${dir}/.basalt`, active)
    expect(removed.sort()).toEqual([...ids.slice(50, 54).map((id) => `${id}.ndjson`), `${old}.cancel`, `${old}.ndjson`].sort())
    expect(host.files.has(`${runs}/${active}.ndjson`)).toBe(true)
    expect(host.file(`${runs}/notes.txt`)).toBe('mine')
    expect(host.files.get(`${runs}/20260101T000000Z-000000000000.ndjson`)?.kind).toBe('dir')
    expect(KEEP_RUN_LOGS).toBe(50)
  })

  it('status --json: the active run from the lock, the last run complete or not, a stale lock', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.dir(`${dir}/.basalt`, 0o700).dir(`${dir}/.basalt/runs`, 0o700)
    host.put(runLogPath(state(), '20261010T090000Z-000000000001'), runLog([hello, { type: 'done', exitCode: 0 }], '20261010T090000Z-000000000001'), 0o600)
    host.put(runLogPath(state(), RUN), runLog([hello, ...lockStep]), 0o600)
    host.alive.add(5100)
    host.put(lockFile(state()), holder(RUN), 0o600)
    const live = ofType((await runJson(['status', '--json', CONFIG], host, dir)).events, 'result')[0]?.data
    expect(live).toMatchObject({
      lock: { holder: { pid: 5100, runId: RUN }, stale: false, corrupt: false },
      activeRun: { runId: RUN, pid: 5100, command: 'run', actor: 'deployer', alive: true },
      lastRun: { runId: RUN, command: 'run', complete: false },
    })
    host.alive.delete(5100)
    host.files.delete(runLogPath(state(), RUN))
    const stale = ofType((await runJson(['status', '--json', CONFIG], host, dir)).events, 'result')[0]?.data
    expect(stale).toMatchObject({ lock: { stale: true }, lastRun: { runId: '20261010T090000Z-000000000001', command: 'run', complete: true, exitCode: 0 } })
    expect(stale).not.toHaveProperty('activeRun')
  })

  it('a locked JSON command prunes the logs after it takes the lock', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.dir(`${dir}/.basalt`, 0o700).dir(`${dir}/.basalt/runs`, 0o700)
    host.put(runLogPath(state(), '20250101T000000Z-000000000001'), '', 0o600)
    expect((await runJson(['run', '--json', CONFIG], host, dir)).code).toBe(0)
    expect(host.files.has(runLogPath(state(), '20250101T000000Z-000000000001'))).toBe(false)
  })
})
