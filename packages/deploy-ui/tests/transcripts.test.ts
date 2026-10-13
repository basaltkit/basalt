import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// The real deploy, driven the way its own tests drive it: these transcripts
// are what @basaltkit/deploy --json writes, not an invented protocol.
import { main, type CliIO } from '../../deploy/src/cli.js'
import { lockFile } from '../../deploy/src/lock.js'
import { FakeHost } from '../../deploy/tests/fake-host.js'
import { GOOD_ENV, OLD, server } from '../../deploy/tests/acme-server.js'
import { ACME_CONFIG, answer, runJson, stdinOf } from '../../deploy/tests/json-helpers.js'

/**
 * Records the transcripts the fake ssh replays (`tests/transcripts/*.ndjson`)
 * from the real phase-1 code, and checks the committed ones still match it:
 * a protocol change in @basaltkit/deploy fails here, not in production.
 *
 *   RECORD_TRANSCRIPTS=1 pnpm --filter @basaltkit/deploy-ui exec vitest run tests/transcripts.test.ts
 *
 * Normalised: the checkout path (a temp directory) becomes /srv/myapp, every
 * `ts` one fixed instant, `hello.version` 0.0.0 — none of them is something
 * the UI may depend on.
 */

const TRANSCRIPTS = join(import.meta.dirname, 'transcripts')
const RECORD = process.env['RECORD_TRANSCRIPTS'] === '1'
const CONFIG = '--config=deploy.config.mjs'
const COMPLETE_ENV = `${GOOD_ENV}SUPPORT_EMAIL=help@example.com\n`
const BARE_ENV = 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3002\nMAILER_URL=\n'
/** What the UI tests type as a secret answer: it must reach the fake ssh's stdin and nothing else. */
export const SECRET = 'sk_live_UI_SECRET_5b1d'
const TS = '2026-10-11T12:00:00.000Z'
let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-ui-rec-'))
  await writeFile(join(dir, 'deploy.config.mjs'), ACME_CONFIG)
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (key === 'ts' && typeof item === 'string') out[key] = TS
      else if (key === 'version' && (value as Record<string, unknown>)['type'] === 'hello') out[key] = '0.0.0'
      else out[key] = normalise(item)
    }
    return out
  }
  return typeof value === 'string' ? value.split(dir).join('/srv/myapp') : value
}

const text = (raw: string) => raw.split('\n').filter(Boolean).map((line) => JSON.stringify(normalise(JSON.parse(line)))).join('\n') + '\n'

async function keep(name: string, raw: string): Promise<void> {
  const path = join(TRANSCRIPTS, `${name}.ndjson`)
  const recorded = text(raw)
  if (RECORD) await writeFile(path, recorded)
  else expect(await readFile(path, 'utf8'), `${name}.ndjson drifted from @basaltkit/deploy: re-record (see this file's header)`).toBe(recorded)
}

const state = () => `${dir}/.basalt`

/** A detached child on the same fake server, in-process (as @basaltkit/deploy's own runs tests do). */
function detachInProcess(parent: FakeHost): { done: () => Promise<number> } {
  let child: Promise<number> | undefined
  parent.sleep = async (ms) => { parent.clock += ms; await new Promise((r) => setTimeout(r, 1)) }
  parent.onDetached = (call) => {
    const host = new FakeHost()
    host.files = parent.files
    host.handlers = parent.handlers
    host.http = parent.http
    host.certificates = parent.certificates
    host.alive = parent.alive
    host.env = { ...call.env }
    host.processId = 5100
    host.alive.add(5100)
    const io: CliIO = {
      write: (t) => call.stdout.append(t),
      stdin: () => stdinOf(call.stdin.split('\n').filter(Boolean)),
      capture: () => () => undefined,
      stderr: () => undefined,
    }
    child = main(call.args.slice(1), host, call.cwd, io).finally(() => host.alive.delete(5100))
    return 5100
  }
  return { done: async () => (child ? await child : -1) }
}

describe('transcripts from the real @basaltkit/deploy --json', () => {
  it('status, plan, env, run --detach, attach, rollback --detach, cancel and their refusals', async () => {
    // plan on a first setup: the questions a run would ask.
    const bare = server({ dir, env: BARE_ENV }).host
    await keep('plan-questions', (await runJson(['plan', '--json=1', CONFIG], bare, dir)).raw)

    // env with its answers (an attended stream; the secret is redacted from every event).
    const envHost = server({ dir, env: BARE_ENV }).host
    await keep('env-answers', (await runJson(['env', '--json=1', '--answers=stdin', '--via=ui', '--actor=alice', CONFIG], envHost, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', SECRET), answer('SUPPORT_EMAIL', 'help@example.com')]))).raw)

    // run --detach: the parent's answer, then the run's own log (what attach replays).
    const { host } = server({ dir, env: BARE_ENV })
    host.dir(state(), 0o700)
    host.put(`${state()}/releases.json`, `${JSON.stringify([{ sha: OLD, at: TS, user: 'deploy', status: 'ok', migrations: [] }], null, 2)}\n`, 0o600)
    const detached = detachInProcess(host)
    const parent = await runJson(['run', '--json=1', '--detach', '--answers=stdin', '--via=ui', '--actor=alice', CONFIG], host, dir, stdinOf([answer('PAYCO_SECRET_TOKEN', SECRET)]))
    expect(parent.code).toBe(0)
    expect(await detached.done()).toBe(0)
    await keep('run-detach', parent.raw)
    const runId = (parent.events.find((e) => e.type === 'result') as { data: { runId: string } }).data.runId
    expect(runId).toBe('20261011T120000Z-aaaaaaaaaaa2')

    const attach0 = await runJson(['attach', runId, '--json=1', '--follow', '--from-seq=0', CONFIG], host, dir)
    expect(attach0.code).toBe(0)
    await keep('attach-from-0', attach0.raw)
    const total = attach0.events.filter((e) => e.type === 'event').length
    await keep('attach-from-10', (await runJson(['attach', runId, '--json=1', '--follow', '--from-seq=10', CONFIG], host, dir)).raw)
    expect(total).toBeGreaterThan(20)

    // status after it: the release, the last run.
    await keep('status-ok', (await runJson(['status', '--json=1', CONFIG], host, dir)).raw)

    // rollback --detach (to the release before).
    const back = detachInProcess(host)
    const rolled = await runJson(['rollback', '--json=1', '--detach', '--via=ui', '--actor=alice', `--to=${OLD}`, CONFIG], host, dir)
    await back.done()
    await keep('rollback-detach', rolled.raw)

    // cancel, twice, of a live detached run.
    const live = server({ dir, env: COMPLETE_ENV }).host
    const RUN = '20261011T120000Z-0123456789ab'
    live.alive.add(5100)
    live.put(lockFile(state()), JSON.stringify({ pid: 5100, host: 'server-1', startedAt: TS, actor: 'alice', command: 'run', runId: RUN }), 0o600)
    live.cmdlines.set(5100, [process.execPath, '/srv/myapp/node_modules/@basaltkit/deploy/dist/bin.js', 'run', '--json=1', `--run-id=${RUN}`])
    await keep('cancel-first', (await runJson(['cancel', RUN, '--json=1', CONFIG], live, dir)).raw)
    await keep('cancel-second', (await runJson(['cancel', RUN, '--json=1', CONFIG], live, dir)).raw)

    // Refusals the UI shows: the lock is held; an answer is missing; no such run.
    const locked = await runJson(['run', '--json=1', '--detach', CONFIG], live, dir)
    expect(locked.code).toBe(3)
    await keep('run-locked', locked.raw)
    const missing = await runJson(['run', '--json=1', '--detach', CONFIG], server({ dir, env: BARE_ENV }).host, dir)
    await keep('run-answer-missing', missing.raw)
    await keep('attach-not-found', (await runJson(['attach', '20261011T120000Z-ffffffffffff', '--json=1', '--follow', CONFIG], live, dir)).raw)
  })
})
