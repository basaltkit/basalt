import { request } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CommandReply, StreamMessage, TargetsReply } from '../src/client/messages.js'
import { SECURITY_HEADERS } from '../src/security.js'
import { startUiServer, type UiServer } from '../src/server.js'
import { control, transcript, type Control } from './helpers.js'

/**
 * The real server on a random loopback port, driven over HTTP like the page
 * drives it, against the fake ssh replaying transcripts recorded from the
 * real @basaltkit/deploy: every MVP flow, every refusal, and the secret's
 * one path (request body → ssh stdin).
 */

const SECRET = 'sk_live_UI_SECRET_5b1d'
let home: string
let targetsPath: string
let clientDir: string
let ssh: Control
let ui: UiServer
let token = ''
let launchCode = ''
const logs: string[] = []
/** Every response body the server sent in this file: the secret must be in none. */
const bodies: string[] = []
let stopped: string | undefined

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ui.port, method, path, headers: { host: `127.0.0.1:${ui.port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        bodies.push(text)
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const apiHeaders = (extra: Record<string, string> = {}) => ({ 'content-type': 'application/json', origin: `http://127.0.0.1:${ui.port}`, 'sec-fetch-site': 'same-origin', authorization: `Bearer ${token}`, ...extra })
const api = (route: string, body: unknown = {}, extra: Record<string, string> = {}) => raw('POST', `/api/${route}`, apiHeaders(extra), JSON.stringify(body))
const ok = async <T>(route: string, body: unknown = {}): Promise<T> => {
  const res = await api(route, body)
  expect(res.status, res.body).toBe(200)
  return JSON.parse(res.body) as T
}
const messages = (res: Raw) => res.body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as StreamMessage)

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'basalt-deploy-ui-home-'))
  targetsPath = join(home, '.config', 'basalt', 'deploy-targets.json')
  clientDir = join(home, 'client')
  await mkdir(clientDir)
  await writeFile(join(clientDir, 'main.js'), 'export {}\n')
  await writeFile(join(clientDir, 'Not-Allowed.js'), 'export {}\n')
  ssh = await control({
    'staging.example.com': {
      status: { transcript: 'status-ok' },
      plan: { transcript: 'plan-questions' },
      run: { transcript: 'run-detach' },
      env: { transcript: 'env-answers' },
      // The connection drops after 11 lines (the run's events 0…9) and in the middle of the 12th; the second attach must resume at 10.
      // The third attaches past the run's done (a re-attach after it ended): attach prints hello and done only.
      attach: [
        { transcript: 'attach-from-0', cut: 11, partial: '{"v":1,"ts":"2026-10-11T12:0', stderr: 'Connection to staging.example.com closed by remote host.\n', exit: 255, expectFromSeq: 0 },
        { transcript: 'attach-from-10', expectFromSeq: 10 },
        {
          lines: [
            '{"v":1,"ts":"2026-10-11T12:00:00.000Z","seq":0,"type":"hello","tool":"@basaltkit/deploy","version":"0.0.0","protocol":1,"command":"attach","pid":4100,"host":"server-1"}',
            '{"v":1,"ts":"2026-10-11T12:00:00.000Z","seq":1,"type":"done","exitCode":0}',
          ],
          expectFromSeq: 47,
        },
      ],
      cancel: [{ transcript: 'cancel-first' }, { transcript: 'cancel-already' }, { transcript: 'cancel-second' }],
    },
    'prod.example.com': {
      rollback: { transcript: 'rollback-detach' },
      run: { transcript: 'run-locked' },
      plan: { transcript: 'plan-questions' },
    },
    'badkey.example.com': { status: { stderr: 'deploy@badkey.example.com: Permission denied (publickey).\r\n', exit: 255 } },
  })
  ui = await startUiServer({
    targetsPath, runner: ssh.runner, osUser: 'alice', clientDir,
    log: (line) => logs.push(line),
    onStop: (reason) => { stopped = reason },
    follow: { sleep: async () => undefined, windowMs: 60_000 },
  })
  launchCode = ui.launchUrl.split('#launch=')[1] as string
})

afterAll(async () => {
  await ui.close()
  await ssh.cleanup()
  await rm(home, { recursive: true, force: true })
})

describe('the local server, end to end', () => {
  it('listens on 127.0.0.1 only, on a port the OS picked; the launch URL carries the code in its fragment', () => {
    expect(ui.url).toBe(`http://127.0.0.1:${ui.port}/`)
    expect(ui.port).toBeGreaterThan(0)
    expect(launchCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('serves the page and its own modules with the security headers; nothing else from disk', async () => {
    const page = await raw('GET', '/')
    expect(page.status).toBe(200)
    expect(page.body).toContain('<script type="module" src="/client/main.js"></script>')
    expect(page.body).not.toMatch(/<script>|\sstyle=|\son[a-z]+=/)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(page.headers[name.toLowerCase()]).toBe(value)
    expect(Object.keys(page.headers).some((h) => h.startsWith('access-control-'))).toBe(false)
    expect((await raw('GET', '/app.css')).headers['content-type']).toMatch(/^text\/css/)
    expect((await raw('GET', '/client/main.js')).status).toBe(200)
    for (const path of ['/client/Not-Allowed.js', '/client/../bin.js', '/client/%2e%2e/bin.js', '/client/nope.js', '/package.json', '//etc/passwd', '/?x=1']) {
      expect((await raw('GET', path)).status, path).toBe(404)
    }
    expect((await raw('POST', '/')).status).toBe(405)
    expect((await raw('HEAD', '/')).body).toBe('')
  })

  it('refuses a rebound Host, a foreign Origin, a cross-site fetch, a form post, GET and OPTIONS, before anything else', async () => {
    for (const host of ['attacker.example', `attacker.example:${ui.port}`, `localhost:${ui.port}`, `127.0.0.1:${ui.port + 1}`, '127.0.0.1']) {
      expect((await raw('POST', '/api/session', { ...apiHeaders(), host }, JSON.stringify({ code: launchCode }))).status, host).toBe(421)
      expect((await raw('GET', '/', { host })).status).toBe(421)
    }
    expect((await raw('POST', '/api/session', apiHeaders({ origin: 'https://attacker.example' }), JSON.stringify({ code: launchCode }))).status).toBe(403)
    expect((await raw('POST', '/api/session', apiHeaders({ origin: `http://localhost:${ui.port}` }), JSON.stringify({ code: launchCode }))).status).toBe(403)
    const { origin: _o, ...noOrigin } = apiHeaders()
    expect((await raw('POST', '/api/session', noOrigin, JSON.stringify({ code: launchCode }))).status).toBe(403)
    expect((await raw('POST', '/api/session', apiHeaders({ 'sec-fetch-site': 'cross-site' }), JSON.stringify({ code: launchCode }))).status).toBe(403)
    expect((await raw('POST', '/api/session', apiHeaders({ 'content-type': 'text/plain' }), JSON.stringify({ code: launchCode }))).status).toBe(415)
    expect((await raw('POST', '/api/session', apiHeaders({ 'content-type': 'application/x-www-form-urlencoded' }), `code=${launchCode}`)).status).toBe(415)
    expect((await raw('GET', '/api/targets', apiHeaders())).status).toBe(405)
    const preflight = await raw('OPTIONS', '/api/session', { origin: 'https://attacker.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' })
    expect(preflight.status).toBe(405)
    expect(Object.keys(preflight.headers).some((h) => h.startsWith('access-control-'))).toBe(false)
    // None of these claimed the session.
    expect(logs.some((l) => l.includes('session is open'))).toBe(false)
  })

  it('exchanges the launch code once; a second claim is refused and printed', async () => {
    expect((await api('targets')).status).toBe(401)
    const wrong = await raw('POST', '/api/session', apiHeaders(), JSON.stringify({ code: 'A'.repeat(43) }))
    expect(wrong.status).toBe(401)
    const first = await raw('POST', '/api/session', apiHeaders(), JSON.stringify({ code: launchCode }))
    expect(first.status).toBe(200)
    token = (JSON.parse(first.body) as { token: string }).token
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(token).not.toBe(launchCode)
    const second = await raw('POST', '/api/session', apiHeaders(), JSON.stringify({ code: launchCode }))
    expect(second.status).toBe(409)
    expect(logs.filter((l) => l.includes('a second browser tried to claim the session'))).toHaveLength(1)
    expect(logs.join('\n')).not.toContain(launchCode)
    expect(logs.join('\n')).not.toContain(token)
    // Wrong, short and malformed tokens.
    for (const auth of ['', `Bearer ${token.slice(1)}`, `Bearer ${token}x`, `bearer ${token}`, `Basic ${token}`, `Bearer ${'A'.repeat(43)}`]) {
      expect((await raw('POST', '/api/targets', apiHeaders({ authorization: auth }), '{}')).status, auth).toBe(401)
    }
  })

  it('caps the body at 1 MiB and wants a JSON object', async () => {
    expect((await raw('POST', '/api/targets', apiHeaders(), Buffer.alloc(1024 * 1024 + 10, 0x20))).status).toBe(413)
    expect((await raw('POST', '/api/targets', apiHeaders(), 'not json')).status).toBe(400)
    expect((await raw('POST', '/api/targets', apiHeaders(), '[1]')).status).toBe(400)
  })

  it('targets: validated field by field, written 0600 outside the repository', async () => {
    const empty = await ok<TargetsReply>('targets')
    expect(empty).toEqual({ path: targetsPath, exists: false, actor: 'alice', targets: [] })
    const refused = await api('targets/save', { target: { name: 'evil', ssh: '-oProxyCommand=touch /tmp/pwned', dir: '/srv/myapp', identityFile: '~/.ssh/id' } })
    expect(refused.status).toBe(422)
    expect(Object.keys((JSON.parse(refused.body) as { errors: Record<string, string> }).errors).sort()).toEqual(['identityFile', 'ssh'])
    await ok('targets/save', { target: { name: 'staging', ssh: 'deploy@staging.example.com', dir: '/srv/myapp' } })
    await ok('targets/save', { target: { name: 'production', ssh: 'deploy@prod.example.com', port: 2222, dir: '/srv/myapp', node: '/usr/local/bin/node', protected: true } })
    await ok('targets/save', { target: { name: 'badkey', ssh: 'deploy@badkey.example.com', dir: '/srv/myapp' } })
    const saved = await ok<TargetsReply>('targets/save', { actor: 'ops.alice' })
    expect(saved.targets.map((t) => t.name)).toEqual(['staging', 'production', 'badkey'])
    expect(saved.actor).toBe('ops.alice')
    if (process.platform !== 'win32') expect((await stat(targetsPath)).mode & 0o777).toBe(0o600)
    const dup = await api('targets/save', { target: { name: 'staging', ssh: 'x', dir: '/a' }, previousName: 'badkey' })
    expect(dup.status).toBe(422)
    expect((await api('status', { target: 'nope' })).status).toBe(404)
    expect((await api('status', { target: '../x' })).status).toBe(400)
  })

  it('status and "check connection": the protocol answers; a refused key is explained', async () => {
    const reply = await ok<CommandReply>('status', { target: 'staging' })
    expect(reply.ok).toBe(true)
    expect(reply.hello).toMatchObject({ type: 'hello', protocol: 1, host: 'server-1', command: 'status' })
    expect(reply.result).toMatchObject({ app: 'acme', releases: [expect.objectContaining({ status: 'ok', via: 'ui', actor: 'alice' }), expect.anything()] })
    const bad = await ok<CommandReply>('status', { target: 'badkey' })
    expect(bad.ok).toBe(false)
    expect(bad.failure).toMatchObject({ code: 'auth', message: 'the server refused your SSH key', hint: expect.stringContaining('ssh-add') })
    expect(bad.diagnostics.join('\n')).toContain('Permission denied (publickey)')
    expect(bad.diagnostics.join('\n')).not.toContain('\r')
  })

  it('plan lists the questions; a run needs a confirmation and answers only to them', async () => {
    const plan = await ok<CommandReply>('plan', { target: 'staging' })
    expect((plan.result as { questions: Array<{ id: string; kind: string }> }).questions.map((q) => [q.id, q.kind])).toEqual([['env.PAYCO_SECRET_TOKEN', 'secret'], ['env.SUPPORT_EMAIL', 'text']])
    const answers = [{ id: 'env.PAYCO_SECRET_TOKEN', value: SECRET }]
    expect((await api('run', { target: 'staging', answers })).status).toBe(428)
    expect((await api('run', { target: 'staging', confirm: true, answers: [{ id: 'env.NOT_ASKED', value: 'x' }] })).status).toBe(400)
    expect((await api('run', { target: 'staging', confirm: true, answers: [{ id: 'env.PAYCO_SECRET_TOKEN', value: 'a\u0000b' }] })).status).toBe(400)
    expect((await api('run', { target: 'staging', confirm: true, answers: [...answers, ...answers] })).status).toBe(400)
    expect((await api('run', { target: 'badkey', confirm: true, answers })).status).toBe(409)
    const before = (await ssh.calls()).length
    const run = await ok<CommandReply>('run', { target: 'staging', confirm: true, answers })
    expect(run.ok).toBe(true)
    expect(run.result).toMatchObject({ runId: '20261011T120000Z-aaaaaaaaaaa2', pid: 5100 })
    const call = (await ssh.calls())[before]
    expect(call?.words.slice(6)).toEqual(['run', '--json=1', '--answers=stdin', '--detach', '--via=ui', '--actor=ops.alice'])
    expect(call?.stdin).toBe(`${JSON.stringify({ v: 1, type: 'answer', id: 'env.PAYCO_SECRET_TOKEN', value: SECRET })}\n`)
  })

  it('attach follows the run; a dropped connection resumes from the next seq — no gap, no duplicate', async () => {
    const before = (await ssh.calls()).length
    const res = await api('attach', { target: 'staging', runId: '20261011T120000Z-aaaaaaaaaaa2', fromSeq: 0 })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/)
    const stream = messages(res)
    const seqs = stream.flatMap((m) => (m.kind === 'event' ? [m.event.seq] : []))
    const recorded = (await transcript('attach-from-0')).slice(1, -1).map((l) => (JSON.parse(l) as { event: { seq: number } }).event.seq)
    expect(seqs).toEqual(recorded)
    expect(stream[0]).toEqual({ kind: 'state', state: 'connecting' })
    expect(stream.filter((m) => m.kind === 'state' && m.state === 'reconnecting')).toHaveLength(1)
    expect(stream.at(-1)).toEqual({ kind: 'state', state: 'ended', exitCode: 0 })
    expect(stream.filter((m) => m.kind === 'hello')).toHaveLength(1)
    const calls = (await ssh.calls()).slice(before)
    expect(calls.map((c) => c.words.slice(6))).toEqual([
      ['attach', '20261011T120000Z-aaaaaaaaaaa2', '--json=1', '--follow', '--from-seq=0'],
      ['attach', '20261011T120000Z-aaaaaaaaaaa2', '--json=1', '--follow', '--from-seq=10'],
    ])
  })

  it('re-attaching past the run\'s done ends at once with its exit code: one ssh call, no reconnect loop', async () => {
    const before = (await ssh.calls()).length
    const stream = messages(await api('attach', { target: 'staging', runId: '20261011T120000Z-aaaaaaaaaaa2', fromSeq: 47 }))
    expect(stream.map((m) => (m.kind === 'state' ? m.state : m.kind))).toEqual(['connecting', 'hello', 'ended'])
    expect(stream.at(-1)).toEqual({ kind: 'state', state: 'ended', exitCode: 0, reason: 'the run had already finished' })
    expect((await ssh.calls()).length - before).toBe(1)
  })

  it('cancel needs a confirmation, and the second one its own — decided by the server, not by this UI\'s memory', async () => {
    const runId = '20261011T120000Z-0123456789ab'
    expect((await api('cancel', { target: 'staging', runId })).status).toBe(428)
    expect((await api('cancel', { target: 'staging', runId: '../../x', confirm: true })).status).toBe(400)
    const before = (await ssh.calls()).length
    const first = await ok<CommandReply>('cancel', { target: 'staging', runId, confirm: true })
    expect(first.result).toMatchObject({ second: false })
    // The server says the run was already cancelled (the marker is there): no signal was sent, the page must confirm the second.
    const again = await api('cancel', { target: 'staging', runId, confirm: true })
    expect(again.status).toBe(428)
    expect(JSON.parse(again.body)).toMatchObject({ second: true, error: expect.stringMatching(/from a terminal/) })
    const second = await ok<CommandReply>('cancel', { target: 'staging', runId, confirm: true, second: true })
    expect(second.result).toMatchObject({ second: true })
    const calls = (await ssh.calls()).slice(before).map((c) => c.words.slice(6))
    expect(calls).toEqual([
      ['cancel', runId, '--json=1', '--first-only'],
      ['cancel', runId, '--json=1', '--first-only'],
      ['cancel', runId, '--json=1'],
    ])
  })

  it('a protected target needs its name typed; rollback --to a picked release', async () => {
    const to = 'a'.repeat(40)
    expect((await api('rollback', { target: 'production', confirm: true, to })).status).toBe(428)
    expect((await api('rollback', { target: 'production', confirm: true, confirmName: 'staging', to })).status).toBe(428)
    expect((await api('rollback', { target: 'production', confirm: true, confirmName: 'production', to: 'HEAD~1' })).status).toBe(400)
    const before = (await ssh.calls()).length
    const reply = await ok<CommandReply>('rollback', { target: 'production', confirm: true, confirmName: 'production', to })
    expect(reply.result).toMatchObject({ runId: '20261011T120000Z-aaaaaaaaaaa3' })
    const call = (await ssh.calls())[before]
    expect(call?.port).toBe(2222)
    expect(call?.words.slice(0, 6)).toEqual(['cd', '/srv/myapp', '&&', 'exec', '/usr/local/bin/node', 'node_modules/@basaltkit/deploy/dist/bin.js'])
    expect(call?.words.slice(6)).toEqual(['rollback', '--json=1', '--detach', `--to=${to}`, '--via=ui', '--actor=ops.alice'])
    // The server's refusal comes back as its error event.
    expect((await api('plan', { target: 'production' })).status).toBe(200)
    const locked = await ok<CommandReply>('run', { target: 'production', confirm: true, confirmName: 'production' })
    expect(locked).toMatchObject({ ok: false, exitCode: 3, error: { code: 'locked', holder: { pid: 5100 } } })
  })

  it('env streams the attended command; the secret goes to ssh stdin and nowhere else', async () => {
    const res = await api('env', { target: 'staging', confirm: true, answers: [{ id: 'env.PAYCO_SECRET_TOKEN', value: SECRET }, { id: 'env.SUPPORT_EMAIL', value: 'help@example.com' }] })
    expect(res.status).toBe(200)
    const stream = messages(res)
    expect(stream[0]).toEqual({ kind: 'state', state: 'connecting' })
    expect(stream[1]).toMatchObject({ kind: 'hello', hello: { command: 'env' } })
    expect(stream.some((m) => m.kind === 'event' && m.event.type === 'result')).toBe(true)
    expect(stream.at(-1)).toEqual({ kind: 'state', state: 'ended', exitCode: 0 })

    const calls = await ssh.calls()
    const withSecret = calls.filter((c) => c.stdin.includes(SECRET))
    expect(withSecret.map((c) => c.words[6])).toEqual(['run', 'env'])
    for (const call of calls) {
      expect(JSON.stringify(call.argv)).not.toContain(SECRET)
      expect(call.envKeys.join(' ')).not.toContain(SECRET)
      // The UI adds nothing to ssh's environment.
      expect(call.envKeys).toEqual(Object.keys(process.env).sort())
    }
    expect(bodies.join('\n')).not.toContain(SECRET)
    expect(logs.join('\n')).not.toContain(SECRET)
    // Every file under the operator's home the UI could have written.
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat()
    for (const file of await walk(home)) expect(await readFile(file, 'utf8'), file).not.toContain(SECRET)
  })

  it('quit stops the server', async () => {
    const res = await api('quit')
    expect(res.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stopped).toBe('quit')
    await expect(raw('GET', '/')).rejects.toThrow()
  })
})
