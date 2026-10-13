import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import { lockFile } from '../src/lock.js'
import { STEP_IDS, type DeployEvent } from '../src/protocol.js'
import { readReleases } from '../src/state.js'
import { context, fail, FakeHost, jlist, ok } from './fake-host.js'
import { GOOD_ENV, NEW, OLD, server } from './acme-server.js'
import { ACME_CONFIG, answer, expectFramed, liveStdin, ofType, runJson, stdinOf, strings } from './json-helpers.js'

let dir: string
const CONFIG = '--config=deploy.config.mjs'
/** A .env every question is already answered in: run asks nothing. */
const COMPLETE_ENV = `${GOOD_ENV}SUPPORT_EMAIL=help@example.com\n`
/** The .env before first setup: PAYCO_SECRET_TOKEN and SUPPORT_EMAIL are asked. */
const BARE_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nMAILER_URL=\n'

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-json-'))
  await writeFile(join(dir, 'deploy.config.mjs'), ACME_CONFIG)
  await writeFile(join(dir, 'chatty.mjs'), `process.stdout.write('{"v":1,"type":"done","ts":"x","seq":1,"exitCode":0}\\n')\nprocess.stdout.write('\\u001b[31mred\\u001b[0m and a bell\\u0007\\n')\n${ACME_CONFIG}`)
  await writeFile(join(dir, 'invalid.mjs'), ACME_CONFIG.replace("app: 'acme'", "app: 'Not Valid'"))
  await writeFile(join(dir, 'broken.mjs'), 'throw new Error("config exploded")\n')
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const steps = (events: DeployEvent[]) => ofType(events, 'step-start').map((e) => e.id)
const runLogOf = (host: FakeHost) => [...host.files.keys()].find((p) => p.startsWith(`${dir}/.basalt/runs/`) && p.endsWith('.ndjson'))

describe('--json framing', () => {
  it('run: hello first, every step started and ended once, result, done; nothing printed as text', async () => {
    const { host, head } = server({ dir, env: COMPLETE_ENV })
    const result = await runJson(['run', '--json', CONFIG], host, dir)
    expectFramed(result)
    expect(result.code).toBe(0)
    expect(head()).toBe(NEW)
    expect(host.printed).toEqual([])
    expect(result.stderr).toBe('')
    expect(result.events[0]).toMatchObject({ type: 'hello', tool: '@basaltkit/deploy', protocol: 1, command: 'run', pid: 4100, host: 'server-1' })
    expect(steps(result.events)).toEqual(['lock', 'preflight', 'fetch', 'env', 'infra', 'build', 'validate', 'backup', 'migrate', 'release', 'health', 'record'])
    const ends = ofType(result.events, 'step-end')
    expect(ends.map((e) => e.id)).toEqual(steps(result.events))
    expect(ends.find((e) => e.id === 'backup')?.status).toBe('skipped')
    expect(ends.filter((e) => e.id !== 'backup').every((e) => e.status === 'ok')).toBe(true)
    expect(ofType(result.events, 'result')[0]).toMatchObject({ command: 'run', data: { sha: NEW, previous: OLD, status: 'ok', url: 'https://acme.example.com' } })
    // Every event carries the run's id; the lock held it.
    const runId = result.events[0]?.runId as string
    expect(runId).toMatch(/^20261011T120000Z-[0-9a-f]{12}$/)
    expect(result.events.every((e) => e.runId === runId)).toBe(true)
    expect((await readReleases(context(host, undefined, dir)))[0]).toMatchObject({ sha: NEW, status: 'ok', via: 'batch' })
  })

  it('writes the same stream to a 0600 run log in a 0700 runs directory', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    const result = await runJson(['run', '--json', CONFIG], host, dir)
    const log = runLogOf(host) as string
    expect(log).toBe(`${dir}/.basalt/runs/${result.events[0]?.runId}.ndjson`)
    expect(host.file(log)).toBe(result.raw)
    expect(host.mode(log)).toBe(0o600)
    expect((await host.stat(`${dir}/.basalt/runs`))?.mode).toBe(0o700)
    expect(host.closedLogs).toEqual([log])
  })

  it('status, check, plan and install-plan: framed, with their typed result', async () => {
    const { host } = server({ dir, env: BARE_ENV })
    const status = await runJson(['status', '--json', CONFIG], host, dir)
    expectFramed(status)
    expect(ofType(status.events, 'result')[0]?.data).toMatchObject({ app: 'acme', stateDir: `${dir}/.basalt`, lock: null, hold: null, releases: [], process: { kind: 'pm2', name: 'acme-api', running: true, status: 'online' } })
    expect(status.events[0]?.runId).toBeUndefined()

    const check = await runJson(['check', '--json', CONFIG], host, dir)
    expectFramed(check)
    expect(ofType(check.events, 'result')[0]?.data).toEqual({ file: 'deploy.config.mjs', app: 'acme', runtime: 'pm2', proxy: 'apache', types: 'not-typescript' })
    expect(ofType(check.events, 'step-end')[0]).toMatchObject({ id: 'check', status: 'ok' })

    const plan = await runJson(['plan', '--json', CONFIG], host, dir)
    expectFramed(plan)
    expect(plan.code).toBe(0)
    const data = ofType(plan.events, 'result')[0]?.data as { lines: Array<{ step: string }>; questions: unknown[]; blocking: boolean }
    expect(data.blocking).toBe(false)
    expect(data.lines.map((l) => l.step)).toContain('migrate')
    // What a run would ask, never with a value; the secret has no default.
    expect(data.questions).toEqual([
      { id: 'env.PAYCO_SECRET_TOKEN', kind: 'secret', message: 'PayCo token [PAYCO_SECRET_TOKEN]', key: 'PAYCO_SECRET_TOKEN', optional: false },
      { id: 'env.SUPPORT_EMAIL', kind: 'text', message: 'Support address [SUPPORT_EMAIL] (empty to skip)', key: 'SUPPORT_EMAIL', optional: true, default: 'help@example.com' },
    ])
    // The deploy's own environment answers first: not asked.
    host.env['PAYCO_SECRET_TOKEN'] = 'from-the-environment'
    const again = await runJson(['plan', '--json', CONFIG], host, dir)
    expect((ofType(again.events, 'result')[0]?.data as { questions: Array<{ key: string }> }).questions.map((q) => q.key)).toEqual(['SUPPORT_EMAIL'])

    const installPlan = await runJson(['install-plan', '--json', CONFIG], host, dir)
    expectFramed(installPlan)
    expect(ofType(installPlan.events, 'result')[0]?.data).toMatchObject({ path: `${dir}/.basalt/install-plan.json`, plan: { app: 'acme' } })
    expect((ofType(installPlan.events, 'result')[0]?.data as { rootCommand: string }).rootCommand).toMatch(/^cd \/ && sudo -H npx/)
  })

  it('env: result with keys and reasons only', async () => {
    const { host } = server({ dir, env: BARE_ENV })
    const result = await runJson(['env', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', 'sk_live_ENV_TOKEN_42')]))
    expectFramed(result)
    expect(result.code).toBe(0)
    expect(steps(result.events)).toEqual(['lock', 'env', 'infra', 'validate'])
    const data = ofType(result.events, 'result')[0]?.data as { file: string; changes: Array<{ key: string }>; port: number }
    expect(data.file).toBe(`${dir}/.env`)
    expect(data.port).toBe(3002)
    expect(data.changes.map((c) => c.key)).toEqual(['APP_SECRET', 'PAYCO_CALLBACK_URL', 'PAYCO_SECRET_TOKEN', 'SUPPORT_EMAIL'])
    expect(JSON.stringify(data)).not.toMatch(/"value"/)
    expect(host.file(`${dir}/.env`)).toContain('PAYCO_SECRET_TOKEN=sk_live_ENV_TOKEN_42')
    expect(host.mode(`${dir}/.env`)).toBe(0o600)
  })

  it('rollback: result, and a run log', async () => {
    const { host, head } = server({ dir, env: COMPLETE_ENV })
    expect((await runJson(['run', '--json', CONFIG], host, dir)).code).toBe(0)
    const result = await runJson(['rollback', '--json', CONFIG], host, dir)
    expectFramed(result)
    expect(head()).toBe(OLD)
    expect(steps(result.events)).toEqual(['lock', 'restore', 'release'])
    expect(ofType(result.events, 'result')[0]?.data).toEqual({ from: NEW, to: OLD, status: 'ok', held: NEW })
  })
})

describe('exit codes ↔ events', () => {
  it('3 — locked, with the holder; the run log says so too', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.alive.add(777)
    host.put(lockFile(`${dir}/.basalt`), JSON.stringify({ pid: 777, host: 'server-1', startedAt: '2026-10-11T11:59:00.000Z', actor: 'alice', command: 'run' }), 0o600)
    const result = await runJson(['run', '--json', CONFIG], host, dir)
    expectFramed(result)
    expect(result.code).toBe(3)
    expect(ofType(result.events, 'error')[0]).toMatchObject({ code: 'locked', holder: { pid: 777, actor: 'alice' } })
    expect(ofType(result.events, 'step-end')).toEqual([expect.objectContaining({ id: 'lock', status: 'failed' })])
    expect(host.commands('git')).toEqual([])
  })

  it('130 — the first signal at a step boundary: result aborted, error aborted, done', async () => {
    const { host, head } = server({ dir, env: COMPLETE_ENV })
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install' && head() === NEW && host.signalListeners.length) host.signal('SIGTERM')
      return undefined
    })
    const result = await runJson(['run', '--json', CONFIG], host, dir)
    expectFramed(result)
    expect(result.code).toBe(130)
    expect(ofType(result.events, 'result')[0]?.data).toMatchObject({ status: 'aborted' })
    expect(ofType(result.events, 'error')[0]).toMatchObject({ code: 'aborted' })
    // The build finishes; the next step does not start; the code is put back.
    expect(ofType(result.events, 'step-end').find((e) => e.id === 'build')?.status).toBe('ok')
    expect(steps(result.events)).not.toContain('validate')
    expect(steps(result.events)).toContain('restore')
    expect(head()).toBe(OLD)
  })

  it('1 — refused root, preflight with the blocking findings, held, release-failed with a result', async () => {
    const root = server({ dir, env: COMPLETE_ENV }).host
    root.userId = 0
    const refused = await runJson(['run', '--json', CONFIG], root, dir)
    expectFramed(refused)
    expect(ofType(refused.events, 'error')[0]).toMatchObject({ code: 'refused-root' })

    const dirty = server({ dir, env: COMPLETE_ENV, dirty: ' M src/app.ts' }).host
    const preflight = await runJson(['run', '--json', CONFIG], dirty, dir)
    expect(preflight.code).toBe(1)
    const error = ofType(preflight.events, 'error')[0]
    expect(error).toMatchObject({ code: 'preflight' })
    expect(error?.findings?.[0]).toMatchObject({ id: 'git', level: 'error' })
    expect(ofType(preflight.events, 'finding').some((f) => f.id === 'git' && f.level === 'error')).toBe(true)
    expect(ofType(preflight.events, 'step-end').find((e) => e.id === 'preflight')?.status).toBe('failed')

    const held = server({ dir, env: COMPLETE_ENV }).host
    held.put(`${dir}/.basalt/hold.json`, JSON.stringify({ sha: NEW, at: 'x', actor: 'bob', note: 'rolled back' }), 0o600)
    expect(ofType((await runJson(['run', '--json', CONFIG], held, dir)).events, 'error')[0]).toMatchObject({ code: 'held' })
    const unheld = await runJson(['run', '--json', CONFIG, '--unhold'], held, dir)
    expect(ofType(unheld.events, 'result')[0]?.data).toMatchObject({ status: 'ok', heldOverride: true })

    const sick = server({ dir, env: COMPLETE_ENV, healthyAt: (sha) => sha === OLD }).host
    const failed = await runJson(['run', '--json', CONFIG], sick, dir)
    expectFramed(failed)
    expect(failed.code).toBe(1)
    expect(ofType(failed.events, 'result')[0]?.data).toMatchObject({ status: 'rolled-back', note: expect.stringContaining('does not answer') })
    expect(ofType(failed.events, 'error')[0]).toMatchObject({ code: 'release-failed' })
    const types = failed.events.map((e) => e.type)
    expect(types.indexOf('result')).toBeLessThan(types.indexOf('error'))
  })

  it('1 — config (invalid or not loadable), unexpected, a blocking plan, a rollback that does not answer', async () => {
    const host = server({ dir, env: COMPLETE_ENV }).host
    const invalid = await runJson(['status', '--json', '--config=invalid.mjs'], host, dir)
    expectFramed(invalid)
    expect(ofType(invalid.events, 'error')[0]).toMatchObject({ code: 'config' })
    const broken = await runJson(['status', '--json', '--config=broken.mjs'], host, dir)
    expectFramed(broken)
    expect(ofType(broken.events, 'error')[0]).toMatchObject({ code: 'config', message: expect.stringContaining('config exploded') })

    const crash = new FakeHost().on(() => { throw new Error('boom') })
    crash.env['BASALT_DEBUG'] = '1'
    const unexpected = await runJson(['status', '--json', CONFIG], crash, dir)
    expectFramed(unexpected)
    expect(ofType(unexpected.events, 'error')[0]).toMatchObject({ code: 'unexpected', message: 'unexpected: boom' })
    expect(ofType(unexpected.events, 'log').some((l) => l.text.includes('Error: boom'))).toBe(true)

    const dirty = server({ dir, env: COMPLETE_ENV, dirty: ' M src/app.ts' }).host
    const plan = await runJson(['plan', '--json', CONFIG], dirty, dir)
    expectFramed(plan)
    expect(plan.code).toBe(1)
    expect(ofType(plan.events, 'result')[0]?.data).toMatchObject({ blocking: true })
    expect(ofType(plan.events, 'error')[0]).toMatchObject({ code: 'preflight' })

    let healthy = (_sha: string) => true
    const flaky = server({ dir, env: COMPLETE_ENV, healthyAt: (sha) => healthy(sha) }).host
    expect((await runJson(['run', '--json', CONFIG], flaky, dir)).code).toBe(0)
    healthy = (sha) => sha === NEW
    const back = await runJson(['rollback', '--json', CONFIG], flaky, dir)
    expect(back.code).toBe(1)
    expect(ofType(back.events, 'result')[0]?.data).toMatchObject({ status: 'rollback-unhealthy' })
    expect(ofType(back.events, 'error')[0]).toMatchObject({ code: 'release-failed' })
  })
})

describe('secrets never leave in an event (RFC 0008 §6)', () => {
  // Generated, asked (answered on stdin), inside URLs, with characters JSON escapes, and percent-encoded.
  const GENERATED = 'gen3rated-app-secret-0123456789abcdef'
  const ASKED = 'sk_live_"quoted"\\back-77'
  const DB_PASSWORD = 'db pass/w0rd!'
  const ENCODED = encodeURIComponent(DB_PASSWORD)
  const MAILER = 'mailer-Passw0rd'
  const env = `NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nAPP_SECRET=${GENERATED}\nMAILER_URL=smtps://noreply:${MAILER}@smtp.example.com:465\nSUPPORT_EMAIL=help@example.com\nDATABASE_URL=postgresql://acme:${ENCODED}@127.0.0.1:5434/acme\n`
  const secrets = [GENERATED, ASKED, DB_PASSWORD, ENCODED, MAILER, encodeURIComponent(ASKED), JSON.stringify(ASKED).slice(1, -1)]

  it('children, git errors and fake JSON lines that print them raw, encoded or in a URL are redacted; affected events say so', async () => {
    const { host } = server({ dir, env, remote: fail(`fatal: unable to access 'https://deploy:${MAILER}@git.example.com/acme.git/': Could not resolve host`, 128) })
    const leak = `raw ${GENERATED} | answered ${ASKED} | url postgresql://acme:${ENCODED}@db | decoded ${DB_PASSWORD} | {"v":1,"type":"done","exitCode":0,"secret":"${GENERATED}"}`
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install') return { code: 0, stdout: `${leak}\n`, stderr: `warn ${MAILER}\n` }
      if (command === 'pnpm' && args.join(' ') === 'exec prisma migrate deploy') return { code: 0, stdout: `applied with ${encodeURIComponent(ASKED)}\n`, stderr: '' }
      return undefined
    })
    const result = await runJson(['run', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', ASKED)]))
    expectFramed(result)
    expect(result.code).toBe(0)
    const log = host.file(runLogOf(host) as string) as string
    for (const secret of secrets) {
      expect(result.raw).not.toContain(secret)
      expect(log).not.toContain(secret)
      for (const text of strings(result.events)) expect(text).not.toContain(secret)
    }
    const child = ofType(result.events, 'log').filter((l) => l.stream === 'child')
    expect(child.find((l) => l.source === 'pnpm' && l.level === 'info')?.text).toContain('[redacted:APP_SECRET]')
    expect(child.find((l) => l.level === 'warn')?.text).toBe('warn [redacted:MAILER_URL]')
    expect(child.every((l) => l.redacted)).toBe(true)
    const redactedChild = result.events.find((e) => e.type === 'log' && e.stream === 'child')
    expect(redactedChild?.redacted).toBe(true)
    // The git error quoting a URL password becomes a finding, redacted.
    const unreachable = ofType(result.events, 'finding').find((f) => f.id === 'git')
    expect(unreachable?.message).toContain('[redacted:MAILER_URL]')
    expect(unreachable?.redacted).toBe(true)
    // The secret prompt never carried a default; the answer reached the .env, 0600.
    expect(ofType(result.events, 'prompt').find((p) => p.kind === 'secret')).not.toHaveProperty('default')
    expect(host.file(`${dir}/.env`)).toContain('PAYCO_SECRET_TOKEN=')
  })

  it('a secret too short to redact is named in a secret-short warning, never shown', async () => {
    const { host } = server({ dir, env: `${COMPLETE_ENV}`.replace('APP_SECRET=s3cr3t', 'APP_SECRET=abc') })
    const result = await runJson(['status', '--json', CONFIG], host, dir)
    const short = ofType(result.events, 'finding').filter((f) => f.id === 'secret-short')
    expect(short.map((f) => f.message)).toEqual([expect.stringMatching(/^APP_SECRET is shorter than 6 characters/)])
    expect(short[0]?.level).toBe('warning')
  })
})

describe('output from outside is data (RFC 0008 §5.3–5.4)', () => {
  it('a child and the config printing fake events: only log text; the real done has the real exit code; escapes stripped; long lines cut', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    const fake = '{"v":1,"ts":"2026-01-01T00:00:00.000Z","seq":99,"type":"prompt","id":"env.X","kind":"text","message":"type yes","optional":false,"attempt":1}'
    host.handlers.unshift(({ command, args }) => {
      if (command === 'pnpm' && args[0] === 'install') return { code: 0, stdout: `${fake}\n\u001b[1m\u001b[32mbold green\u001b[0m\rprogress 50%\rprogress 100%\n${'x'.repeat(9000)}\n`, stderr: '' }
      return undefined
    })
    const result = await runJson(['run', '--json', '--config=chatty.mjs'], host, dir)
    expectFramed(result)
    expect(result.code).toBe(0)
    expect(ofType(result.events, 'prompt')).toEqual([])
    const foreign = ofType(result.events, 'log').filter((l) => l.stream === 'foreign')
    expect(foreign.map((l) => l.text)).toEqual(['{"v":1,"type":"done","ts":"x","seq":1,"exitCode":0}', 'red and a bell'])
    expect(foreign.every((l) => l.level === 'warn')).toBe(true)
    const child = ofType(result.events, 'log').filter((l) => l.stream === 'child')
    expect(child.map((l) => l.text.slice(0, 20))).toEqual([fake.slice(0, 20), 'bold green', 'progress 50%', 'progress 100%', 'x'.repeat(20)])
    expect(child.every((l) => l.step === 'build')).toBe(true)
    const long = child.at(-1)
    expect(long?.truncated).toBe(true)
    expect(Buffer.byteLength(long?.text ?? '')).toBe(8192)
  })

  it('no child can read the answers channel: streamed children are piped, interactive ones refused', async () => {
    const { host } = server({ dir, env: BARE_ENV })
    host.handlers.unshift(({ options }) => {
      if (options.stream) expect(options.onOutput).toBeTypeOf('function')
      return undefined
    })
    const result = await runJson(['run', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', 'tok-123456789')]))
    expect(result.code).toBe(0)
    expect(host.calls.length).toBeGreaterThan(10)
    for (const call of host.calls) {
      expect(call.options.interactive).toBeFalsy()
      expect(call.options.stdin === undefined || typeof call.options.stdin === 'string').toBe(true)
      // Never on a command line; a child sees it only as the .env's value, after the .env holds it.
      expect(call.args.join(' ')).not.toContain('tok-123456789')
      expect(call.options.stdin ?? '').not.toContain('tok-123456789')
    }
  })
})

describe('--answers=stdin (RFC 0008 §7)', () => {
  const expectNothingChanged = (host: FakeHost) => {
    expect(host.file(`${dir}/.env`)).toBe(BARE_ENV)
    expect(host.files.has(lockFile(`${dir}/.basalt`))).toBe(false)
    expect(host.commands('git').some((c) => c.startsWith('git fetch'))).toBe(false)
  }

  it('fail closed before the lock: unknown id, duplicate, wrong v, not a string, oversized, too many lines', async () => {
    const cases: Array<[string[], 'answer-unknown' | 'protocol']> = [
      [[answer('PAYCO_SECRET_TOKN', 'x')], 'answer-unknown'],
      [[answer('PAYCO_SECRET_TOKEN', 'a-token-1'), answer('PAYCO_SECRET_TOKEN', 'a-token-2')], 'protocol'],
      [[JSON.stringify({ v: 2, type: 'answer', id: 'env.PAYCO_SECRET_TOKEN', value: 'x' })], 'protocol'],
      [[JSON.stringify({ v: 1, type: 'answer', id: 'env.PAYCO_SECRET_TOKEN', value: 42 })], 'protocol'],
      [[JSON.stringify({ v: 1, type: 'answer', id: 'PAYCO_SECRET_TOKEN', value: 'x' })], 'protocol'],
      [['not json'], 'protocol'],
      [[answer('PAYCO_SECRET_TOKEN', 'y'.repeat(70_000))], 'protocol'],
    ]
    for (const [lines, code] of cases) {
      const { host } = server({ dir, env: BARE_ENV })
      const result = await runJson(['run', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf(lines))
      expectFramed(result)
      expect(result.code).toBe(1)
      expect(ofType(result.events, 'error')[0]?.code).toBe(code)
      expect(steps(result.events)).toEqual([])
      expectNothingChanged(host)
      expect(result.raw).not.toContain('a-token-')
    }
    const many = server({ dir, env: BARE_ENV }).host
    const flood = await runJson(['env', '--json', CONFIG, '--answers=stdin'], many, dir, stdinOf(Array.from({ length: 257 }, (_, i) => answer(`SUPPORT_EMAIL`, `x${i}`))))
    expect(ofType(flood.events, 'error')[0]?.code).toBe('protocol')
  })

  it('stdin closed early: a required one is missing; an optional text takes its default; an optional secret is left out', async () => {
    const { host } = server({ dir, env: BARE_ENV.replace('MAILER_URL=\n', '') })
    const missing = await runJson(['env', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([]))
    expectFramed(missing)
    expect(ofType(missing.events, 'error')[0]).toMatchObject({ code: 'answer-missing', message: expect.stringContaining('PAYCO_SECRET_TOKEN'), hint: expect.stringContaining('--answers=stdin') })
    expect(host.file(`${dir}/.env`)).toBe(BARE_ENV.replace('MAILER_URL=\n', ''))

    const answered = await runJson(['env', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', 'tok-abcdef-1')]))
    expect(answered.code).toBe(0)
    const written = host.file(`${dir}/.env`) as string
    expect(written).toContain('SUPPORT_EMAIL=help@example.com')
    expect(written).not.toMatch(/^MAILER_URL=/m)
    expect(ofType(answered.events, 'log').some((l) => l.text === 'MAILER_URL was not answered: left out of the .env')).toBe(true)
    expect(ofType(answered.events, 'prompt').map((p) => p.id)).toEqual(['env.MAILER_URL', 'env.PAYCO_SECRET_TOKEN', 'env.SUPPORT_EMAIL'])
  })

  it('--json without --answers: a question that needs asking is answer-missing; the environment still answers first', async () => {
    const { host } = server({ dir, env: BARE_ENV })
    const result = await runJson(['env', '--json', CONFIG], host, dir)
    expect(ofType(result.events, 'error')[0]).toMatchObject({ code: 'answer-missing' })
    expect(ofType(result.events, 'prompt')).toEqual([])
    host.env['PAYCO_SECRET_TOKEN'] = 'from-env-123456'
    const answered = await runJson(['env', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', 'from-stdin-123456')]))
    expect(answered.code).toBe(0)
    expect(host.file(`${dir}/.env`)).toContain('PAYCO_SECRET_TOKEN=from-env-123456')
    // The unneeded answer is dropped, said by key; its value stays redacted.
    expect(ofType(answered.events, 'log').some((l) => l.text.startsWith('the answer for PAYCO_SECRET_TOKEN was not needed'))).toBe(true)
    expect(answered.raw).not.toContain('from-stdin-123456')
  })

  it('an invalid answer sent up front gets no second chance: answer-invalid, nothing written', async () => {
    const { host } = server({ dir, env: BARE_ENV })
    const result = await runJson(['env', '--json', CONFIG, '--answers=stdin'], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', `it's "bad"`)]))
    expectFramed(result)
    expect(ofType(result.events, 'error')[0]).toMatchObject({ code: 'answer-invalid' })
    expect(host.file(`${dir}/.env`)).toBe(BARE_ENV)
    expect(result.raw).not.toContain(`it's`)
  })

  it('live: a refused answer is asked again (attempt 2); answers that arrive later are taken; a timeout fails closed', async () => {
    const { host } = server({ dir, env: BARE_ENV })
    const live = liveStdin()
    host.handlers.unshift(() => undefined)
    const pending = runJson(['env', '--json', CONFIG, '--answers=stdin'], host, dir, live.source)
    await vi.waitFor(() => expect(host.files.has(lockFile(`${dir}/.basalt`))).toBe(true))
    live.send(answer('PAYCO_SECRET_TOKEN', ''))
    await new Promise((r) => setTimeout(r, 20))
    live.send(answer('PAYCO_SECRET_TOKEN', 'second-try-123'))
    live.send(answer('SUPPORT_EMAIL', 'ops@example.com'))
    live.close()
    const result = await pending
    expectFramed(result)
    expect(result.code).toBe(0)
    expect(ofType(result.events, 'prompt').filter((p) => p.id === 'env.PAYCO_SECRET_TOKEN').map((p) => p.attempt)).toEqual([1, 2])
    expect(ofType(result.events, 'log').some((l) => l.text === 'PAYCO_SECRET_TOKEN is required')).toBe(true)
    expect(host.file(`${dir}/.env`)).toContain('SUPPORT_EMAIL=ops@example.com')

    const slow = server({ dir, env: BARE_ENV }).host
    const never = liveStdin()
    const timedOut = await runJson(['env', '--json', CONFIG, '--answers=stdin', '--answer-timeout=1'], slow, dir, never.source)
    never.close()
    expectFramed(timedOut)
    expect(ofType(timedOut.events, 'error')[0]).toMatchObject({ code: 'answer-timeout' })
    expect(slow.file(`${dir}/.env`)).toBe(BARE_ENV)
    expect(slow.files.has(lockFile(`${dir}/.basalt`))).toBe(false)
  })
})

describe('refusals (RFC 0008 §3, §9)', () => {
  it('--json on root commands and init; flags out of place; --json=2; help; unknown command; install-plan --out=-', async () => {
    const cases: Array<[string[], string, Record<string, string>?]> = [
      [['install', '--json', '--plan=/x'], 'unsupported'],
      [['bootstrap', '--json'], 'unsupported'],
      [['init', '--json'], 'unsupported'],
      [['status', '--json=2'], 'protocol-version'],
      [['--json', '--help'], 'usage'],
      [['--json'], 'usage'],
      [['deploy-everything', '--json'], 'usage'],
      [['env', '--json', '--detach'], 'usage'],
      [['plan', '--json', '--detach'], 'usage'],
      [['status', '--json', '--answers=stdin'], 'usage'],
      [['run', '--json', '--answers=file'], 'usage'],
      [['run', '--json', '--answer-timeout=10'], 'usage'],
      [['run', '--json', '--answers=stdin', '--answer-timeout=0'], 'usage'],
      [['run', '--json', '--follow'], 'usage'],
      [['run', '--json', '--run-id=20261011T120000Z-aaaaaaaaaaa1'], 'usage'],
      [['run', '--json', '--via=web'], 'usage'],
      [['install-plan', '--json', '--out=-'], 'usage'],
      [['attach', '--json'], 'usage'],
      [['status', '--json', '--skip=migrate'], 'usage'],
    ]
    for (const [argv, code] of cases) {
      const host = new FakeHost()
      const result = await runJson([...argv, CONFIG], host, dir)
      expectFramed(result)
      expect(result.code, argv.join(' ')).toBe(1)
      expect(ofType(result.events, 'error')[0]?.code, argv.join(' ')).toBe(code)
      expect(host.calls).toEqual([])
    }
  })

  it('without --json: the protocol flags and attach are refused as text', async () => {
    for (const argv of [['run', '--answers=stdin'], ['run', '--detach'], ['attach', '20261011T120000Z-aaaaaaaaaaa1']]) {
      const host = new FakeHost()
      expect(await main([...argv, CONFIG], host, dir)).toBe(1)
      expect(host.printed[0]).toMatch(/^ERROR (--answers needs --json|--detach needs --json|attach speaks only --json)/)
    }
  })

  it('--via=ui is recorded as the release\'s via', async () => {
    const { host } = server({ dir, env: COMPLETE_ENV })
    host.env['SSH_CONNECTION'] = '192.0.2.10 50000 192.0.2.1 22'
    expect((await runJson(['run', '--json', CONFIG, '--via=ui', '--actor=ops-ui'], host, dir)).code).toBe(0)
    expect((await readReleases(context(host, undefined, dir)))[0]).toMatchObject({ via: 'ui', actor: 'ops-ui', client: '192.0.2.10' })
  })
})

describe('human mode is unchanged', () => {
  it('main without --json prints what the pipeline prints, nothing on stdout, no lock step, no events', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const viaMain = server({ dir, env: COMPLETE_ENV }).host
      expect(await main(['run', CONFIG], viaMain, dir)).toBe(0)
      expect(write).not.toHaveBeenCalled()
      expect(viaMain.printed.filter((l) => l.startsWith('STEP')).map((l) => l.slice(5))).toEqual(
        ['preflight', 'fetch', 'env', 'infra', 'build', 'validate', 'backup', 'migrate', 'release', 'health', 'record'],
      )
      expect(viaMain.printed.some((l) => l.startsWith('{'))).toBe(false)
      expect([...viaMain.files.keys()].some((p) => p.includes('/runs/'))).toBe(false)
      // A step id is never a new line on a terminal.
      for (const id of STEP_IDS) expect(viaMain.printed).not.toContain(`STEP ${id} ${id}`)
    } finally {
      write.mockRestore()
    }
  })

  it('a pm2 status, a held lock and errors read as they did', async () => {
    const host = server({ dir, env: COMPLETE_ENV }).host
    host.on(({ command }) => (command === 'pm2' ? ok(jlist()) : undefined))
    expect(await main(['status', CONFIG], host, dir)).toBe(0)
    expect(host.printed[0]).toBe('STEP acme — last 0 release(s)')
    const bad = new FakeHost()
    expect(await main(['run', '--skip=migrate', CONFIG], bad, dir)).toBe(1)
    expect(bad.printed).toEqual(['ERROR --skip=migrate: only fetch, backup, tls can be skipped'])
  })
})
