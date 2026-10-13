// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { PlanResult, StatusResult } from '@basaltkit/deploy/protocol'
import { Api, ApiError, type Fetch } from '../src/client/api.js'
import { App } from '../src/client/app.js'
import type { CommandReply, TargetsReply } from '../src/client/messages.js'
import { problem } from '../src/client/reply.js'
import { INDEX_HTML } from '../src/page.js'

/**
 * Each screen's states against a scripted local API: what the page shows
 * for every shape of reply, and what it sends.
 */

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const RUN = '20261011T120000Z-0123456789ab'
const hello = { v: 1, ts: '2026-10-11T12:00:00.000Z', seq: 0, type: 'hello', tool: '@basaltkit/deploy', version: '0.5.0', protocol: 1, command: 'status', pid: 1, host: 'server-1' } as const
const targets: TargetsReply = {
  path: '/home/alice/.config/basalt/deploy-targets.json', exists: true, actor: 'alice',
  targets: [{ name: 'staging', ssh: 'deploy@staging.example.com', dir: '/srv/myapp' }, { name: 'production', ssh: 'myapp-prod', port: 2222, dir: '/srv/myapp', protected: true }],
}
const status = (over: Partial<StatusResult> = {}): StatusResult => ({
  app: 'myapp', stateDir: '/srv/myapp/.basalt', lock: null, hold: null,
  releases: [
    { sha: 'b'.repeat(40), at: '2026-10-11T12:00:00.000Z', user: 'deploy', status: 'ok', migrations: ['20261011_init'], actor: 'alice', via: 'ui', client: '192.0.2.10' },
    { sha: 'a'.repeat(40), at: '2026-10-10T12:00:00.000Z', user: 'deploy', status: 'ok', migrations: [] },
    { sha: 'c'.repeat(40), at: '2026-10-09T12:00:00.000Z', user: 'deploy', status: 'failed', migrations: [], note: 'build failed', backup: '/srv/myapp/.basalt/backups/x.dump' },
  ],
  process: { kind: 'pm2', name: 'myapp-api', running: true, status: 'online', pid: 42 },
  ...over,
})
const plan = (over: Partial<PlanResult> = {}): PlanResult => ({
  findings: [{ id: 'C4', level: 'warning', message: 'the certificate expires in 9 days', fix: 'certbot renew' }, { id: 'C2', level: 'error', message: 'the tree is dirty', fix: 'git stash' }],
  lines: [{ step: 'migrate', text: 'prisma migrate deploy' }, { step: 'release', text: 'pm2 restart' }],
  questions: [
    { id: 'env.API_TOKEN', kind: 'secret', message: 'API token', key: 'API_TOKEN', optional: false },
    { id: 'env.REGION', kind: 'choice', message: 'Region', optional: true, choices: ['eu', 'us'], default: 'eu' },
    { id: 'env.METRICS', kind: 'confirm', message: 'Send metrics?', optional: false, default: 'yes' },
    { id: 'env.SUPPORT_EMAIL', kind: 'text', message: 'Support address', optional: true, default: 'help@example.com' },
  ],
  blocking: false,
  ...over,
})
const reply = (result: unknown, over: Partial<CommandReply> = {}): CommandReply => ({ ok: true, hello: hello as never, result, exitCode: 0, diagnostics: [], ...over })

let routes: Record<string, Handler>
let sent: Array<{ route: string; body: Record<string, unknown> }>
let app: App

const fetchImpl: Fetch = async (input, init) => {
  const route = input.replace('/api/', '')
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  sent.push({ route, body })
  const handler = routes[route]
  if (!handler) return json({ error: `no route ${route}` }, 404)
  return handler(body)
}

const until = async (check: () => boolean, what = 'condition') => {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${document.getElementById('app')?.textContent?.slice(0, 1500)}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const main = () => document.getElementById('app') as HTMLElement
const has = (text: string) => main().textContent?.includes(text) === true
const click = (label: string | RegExp, scope: ParentNode = document) => {
  const button = [...scope.querySelectorAll('button')].find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')))
  if (!button) throw new Error(`no button ${label}: ${[...scope.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  button.click()
}
const confirmDialog = async (label: string) => {
  await until(() => document.querySelector('dialog') !== null, 'a dialog')
  click(label, document.querySelector('dialog') as HTMLDialogElement)
}

async function start(): Promise<void> {
  document.documentElement.innerHTML = INDEX_HTML.replace(/^<!doctype html>\n/, '')
  app = new App(new Api('tok', fetchImpl), {
    nav: document.getElementById('nav') as HTMLElement,
    bar: document.getElementById('target-bar') as HTMLElement,
    main: main(),
    session: document.getElementById('session') as HTMLElement,
  }, sessionStorage)
  await app.start()
}

beforeEach(() => {
  sent = []
  sessionStorage.clear()
  routes = {
    targets: () => json(targets),
    status: () => json(reply(status())),
    plan: () => json(reply(plan())),
  }
})

describe('status', () => {
  it('a live lock, an active run to attach, the last run, a hold, compose lines', async () => {
    routes['status'] = () => json(reply(status({
      lock: { holder: { pid: 5100, host: 'server-1', startedAt: '2026-10-11T12:00:00.000Z', actor: 'bob', command: 'run', runId: RUN }, stale: false, corrupt: false },
      activeRun: { runId: RUN, pid: 5100, command: 'run', actor: 'bob', startedAt: '2026-10-11T12:00:00.000Z', alive: false },
      lastRun: { runId: '20261010T120000Z-0123456789ab', command: 'rollback', complete: false },
      hold: { sha: 'a'.repeat(40), at: '2026-10-11T12:00:00.000Z', actor: 'bob', note: 'rolled back from bbbbbbb' },
      process: { kind: 'compose', lines: ['myapp-api  running', 'myapp-worker  restarting'] },
    })))
    await start()
    await until(() => has('Active run'))
    expect(has('Held by pid 5100 on server-1 — bob, run')).toBe(true)
    expect(has('not seen alive')).toBe(true)
    expect(has('did not end with done')).toBe(true)
    expect(has('is held since')).toBe(true)
    expect(has('myapp-worker  restarting')).toBe(true)
    expect(document.querySelector('.target-bar')?.textContent).toBe('staging · deploy@staging.example.com · /srv/myapp · host server-1 · deploy 0.5.0 · app myapp')
    routes['attach'] = () => new Response(`${JSON.stringify({ kind: 'state', state: 'ended', exitCode: 0 })}\n`)
    click('Attach')
    await until(() => sent.some((s) => s.route === 'attach'))
    expect(sent.find((s) => s.route === 'attach')?.body).toEqual({ target: 'staging', runId: RUN, fromSeq: 0 })
  })

  it('a stale or corrupt lock, a stopped process, a finished last run; a failure is explained with diagnostics', async () => {
    routes['status'] = () => json(reply(status({
      lock: { stale: true, corrupt: true },
      lastRun: { runId: RUN, command: 'run', complete: true, exitCode: 1, endedAt: '2026-10-11T12:00:00.000Z' },
      process: { kind: 'pm2', name: 'myapp-api', running: false },
      releases: [],
    }), { diagnostics: ['Welcome'] }))
    await start()
    await until(() => has('Corrupt lock file'))
    expect(has('stale: that process is gone')).toBe(true)
    expect(has('not running')).toBe(true)
    expect(has('exit 1')).toBe(true)
    expect(has('No healthy release recorded yet.')).toBe(true)
    expect(main().querySelector('details pre')?.textContent).toBe('Welcome')
    routes['status'] = () => json({ ok: false, failure: { code: 'host-key', message: 'this host\'s key is not in your known_hosts', hint: 'connect once from a terminal' }, diagnostics: ['Host key verification failed.'] })
    click('Refresh')
    await until(() => has('known_hosts'))
    expect(main().querySelector('[role="alert"]')?.textContent).toMatch(/known_hosts.*\[host-key\].*connect once/s)
    routes['status'] = () => json({ error: 'at most 4 ssh sessions at a time' }, 429)
    click('Refresh')
    await until(() => has('at most 4 ssh sessions'))
  })
})

describe('plan & deploy', () => {
  it('findings errors first, the steps, every kind of question; a blocking plan disables Deploy', async () => {
    routes['plan'] = () => json(reply(plan({ blocking: true }), { ok: false, exitCode: 1 }))
    await start()
    click('Plan & deploy')
    click('Run plan')
    await until(() => has('What a run would do'))
    const findings = [...main().querySelectorAll('ul li')].map((li) => li.textContent)
    expect(findings[0]).toMatch(/^Error \[C2\] the tree is dirtyFix: git stash/)
    expect((document.getElementById('q-0') as HTMLInputElement).type).toBe('password')
    expect((document.getElementById('q-1') as HTMLSelectElement).value).toBe('eu')
    expect((document.getElementById('q-2') as HTMLInputElement).checked).toBe(true)
    expect([...main().querySelectorAll('button')].find((b) => b.textContent === 'Deploy…')?.disabled).toBe(true)
    expect(has('stop a run')).toBe(true)
  })

  it('deploy: the confirm names the server and the migration; answers sent once, every field emptied; a refused answer points at its field', async () => {
    routes['status'] = () => json(reply(status({ hold: { sha: 'a'.repeat(40), at: '2026-10-11T12:00:00.000Z', actor: 'bob', note: 'held' } })))
    routes['run'] = () => json({ ok: false, hello, error: { v: 1, ts: 'x', seq: 1, type: 'error', code: 'answer-invalid', message: 'the answer for env.API_TOKEN is refused: too short' }, exitCode: 1, diagnostics: [] })
    await start()
    await until(() => has('Current release'))
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null)
    ;(document.getElementById('q-0') as HTMLInputElement).value = 'short'
    ;(document.getElementById('q-3') as HTMLInputElement).value = ''
    ;(document.getElementById('unhold') as HTMLInputElement).checked = true
    click('Deploy…')
    await until(() => document.querySelector('dialog') !== null)
    expect(document.querySelector('dialog')?.textContent).toMatch(/Deploy to staging\?.*host server-1.*app myapp.*This will migrate the database/s)
    await confirmDialog('Deploy')
    await until(() => sent.some((s) => s.route === 'run'))
    const body = sent.find((s) => s.route === 'run')?.body
    expect(body).toEqual({ target: 'staging', confirm: true, confirmedTarget: targets.targets[0], unhold: true, answers: [{ id: 'env.API_TOKEN', value: 'short' }, { id: 'env.REGION', value: 'eu' }, { id: 'env.METRICS', value: 'yes' }] })
    for (const id of ['q-0', 'q-1', 'q-3']) expect((document.getElementById(id) as HTMLInputElement).value, id).toBe('')
    expect((document.getElementById('q-2') as HTMLInputElement).checked).toBe(false)
    await until(() => (document.getElementById('q-0-error')?.textContent ?? '') !== '')
    expect(document.getElementById('q-0-error')?.textContent).toMatch(/too short — type it again/)
  })

  it('the local server refuses an answer: the field says so', async () => {
    routes['run'] = () => json({ error: 'answers: env.API_TOKEN is not one of the questions of the last plan', field: 'env.API_TOKEN' }, 400)
    await start()
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null)
    ;(document.getElementById('q-0') as HTMLInputElement).value = 'tok'
    click('Deploy…')
    await confirmDialog('Deploy')
    await until(() => (document.getElementById('q-0-error')?.textContent ?? '') !== '')
    expect(has('The UI refused the request')).toBe(true)
  })

  it('the target changed in the file after the confirmation: refused, said so, and the page shows the file\'s values again', async () => {
    routes['run'] = () => json({ error: 'staging changed in the targets file after you confirmed (deploy@staging.example.com · /srv/myapp → deploy@other.example.com · /srv/myapp): nothing was sent — check it and confirm again', changed: true }, 409)
    await start()
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null)
    ;(document.getElementById('q-0') as HTMLInputElement).value = 'tok'
    routes['targets'] = () => json({ ...targets, targets: [{ ...targets.targets[0], ssh: 'deploy@other.example.com' }, targets.targets[1]] })
    click('Deploy…')
    await confirmDialog('Deploy')
    await until(() => has('changed in the targets file after you confirmed'))
    await until(() => document.getElementById('target-bar')?.textContent?.includes('deploy@other.example.com') === true, 'the bar with the new ssh')
    expect(app.current?.ssh).toBe('deploy@other.example.com')
  })

  it('a required secret left empty: the browser does not submit', async () => {
    await start()
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null)
    click('Deploy…')
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('a detached run opens the live view; attended and env-only stream in the page; protected needs the name', async () => {
    const fill = () => { (document.getElementById('q-0') as HTMLInputElement).value = 'tok' }
    routes['run'] = (body) => (body['attended'] ? new Response(`${JSON.stringify({ kind: 'state', state: 'ended', exitCode: 0 })}\n`) : json(reply({ runId: RUN, pid: 5100, log: '/x' })))
    routes['attach'] = () => new Response(`${JSON.stringify({ kind: 'hello', hello })}\n${JSON.stringify({ kind: 'state', state: 'ended', exitCode: 0 })}\n`)
    routes['env'] = () => new Response(`${JSON.stringify({ kind: 'state', state: 'ended', code: 'abnormal', reason: 'the output ended without done' })}\n`)
    await start()
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null)
    fill()
    click('Deploy…')
    await confirmDialog('Deploy')
    await until(() => document.getElementById('run-title')?.textContent === `run ${RUN}`)
    await until(() => has('Finished: exit 0'))
    click('Plan & deploy')
    ;(document.getElementById('attended') as HTMLInputElement).checked = true
    fill()
    click('Deploy…')
    await confirmDialog('Deploy')
    await until(() => document.getElementById('run-title')?.textContent === 'run on staging (attended)')
    expect(sent.find((s) => s.route === 'run' && s.body['attended'])?.body).toMatchObject({ attended: true, confirm: true })
    click('Plan & deploy')
    click('Write .env only…')
    await until(() => document.querySelector('dialog')?.textContent?.includes('Write the .env') === true)
    await confirmDialog('Write .env')
    await until(() => has('the output ended without done'))
    expect(has('[abnormal]')).toBe(true)

    // production is protected: the confirm needs its name.
    const select = document.querySelector('nav select') as HTMLSelectElement
    select.value = 'production'
    select.dispatchEvent(new Event('change'))
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null)
    fill()
    click('Deploy…')
    await until(() => document.querySelector('dialog') !== null)
    const name = document.getElementById('confirm-name') as HTMLInputElement
    name.value = 'production'
    name.dispatchEvent(new Event('input'))
    await confirmDialog('Deploy')
    await until(() => sent.filter((s) => s.route === 'run').length === 3)
    expect(sent.filter((s) => s.route === 'run').at(-1)?.body).toMatchObject({ target: 'production', confirmName: 'production' })
  })

  it('no plan came back: the failure is shown', async () => {
    routes['plan'] = () => json({ ok: false, failure: { code: 'timeout', message: 'the command took too long and was stopped' }, diagnostics: [] })
    await start()
    click('Plan & deploy')
    click('Run plan')
    await until(() => has('took too long'))
  })
})

describe('targets', () => {
  it('check connection, edit, remove, the actor', async () => {
    let list = targets
    routes['targets/save'] = (body) => {
      if (body['actor'] === 'bad actor') return json({ error: 'the actor is refused', errors: { actor: 'letters, digits and ._@+-' } }, 422)
      if (body['target']) list = { ...list, targets: list.targets.map((t) => (t.name === body['previousName'] ? body['target'] as never : t)) }
      return json({ ...list, actor: body['actor'] ?? list.actor })
    }
    routes['targets/remove'] = (body) => { list = { ...list, targets: list.targets.filter((t) => t.name !== body['name']) }; return json(list) }
    routes['targets'] = () => json(list)
    await start()
    click('Targets')
    expect(has('/home/alice/.config/basalt/deploy-targets.json')).toBe(true)
    click('Check connection')
    await until(() => has('staging answers: @basaltkit/deploy 0.5.0, protocol 1, host server-1'))
    routes['status'] = () => json({ ok: false, failure: { code: 'auth', message: 'the server refused your SSH key', hint: 'ssh-add' }, diagnostics: [] })
    click('Check connection')
    await until(() => has('refused your SSH key'))
    routes['status'] = () => json({ error: 'boom' }, 500)
    click('Check connection')
    await until(() => has('boom (HTTP 500)'))

    const actor = document.getElementById('actor') as HTMLInputElement
    actor.value = 'bad actor'
    click('Save actor')
    await until(() => has('the actor is refused'))
    actor.value = 'ops.alice'
    click('Save actor')
    await until(() => has('Saved.'))

    click('Edit')
    const ssh = document.getElementById('target-ssh') as HTMLInputElement
    expect(ssh.value).toBe('deploy@staging.example.com')
    ;(document.getElementById('target-port') as HTMLInputElement).value = '2200'
    click('Save')
    await until(() => sent.some((s) => s.route === 'targets/save' && s.body['previousName'] === 'staging'))
    expect(sent.find((s) => s.body['previousName'] === 'staging')?.body['target']).toEqual({ name: 'staging', ssh: 'deploy@staging.example.com', port: 2200, dir: '/srv/myapp' })

    click('Remove')
    await confirmDialog('Cancel')
    expect(sent.some((s) => s.route === 'targets/remove')).toBe(false)
    click('Remove')
    await confirmDialog('Remove')
    await until(() => sent.some((s) => s.route === 'targets/remove'))
    await until(() => !document.querySelector('table')?.textContent?.includes('staging'))
  })

  it('a refused targets file is shown, with no form to overwrite it silently', async () => {
    routes['targets'] = () => json({ path: '/x.json', exists: true, targets: [], error: '/x.json is writable by other users' })
    await start()
    expect(has('writable by other users')).toBe(true)
    expect(has('Add a target first.')).toBe(false)
    click('Status')
    expect(has('Add a target first.')).toBe(true)
    click('Run')
    expect(has('Add a target first.')).toBe(true)
  })
})

describe('history, rollback, quit', () => {
  it('the releases table; rollback to a picked release; a failed rollback start is shown', async () => {
    routes['rollback'] = (body) => (body['to'] ? json(reply({ runId: RUN, pid: 5100, log: '/x' })) : json({ ok: false, hello, error: { v: 1, ts: 'x', seq: 1, type: 'error', code: 'locked', message: 'another deploy is running', holder: { pid: 5100, host: 'server-1', startedAt: 'x', actor: 'bob', command: 'run', runId: RUN } }, exitCode: 3, diagnostics: [] }))
    routes['attach'] = () => new Response('')
    await start()
    await until(() => has('Current release'))
    click('History')
    const rows = [...main().querySelectorAll('tbody tr')].map((tr) => tr.textContent)
    expect(rows[0]).toMatch(/^bbbbbbbbbbbb.*ok.*alice.*ui.*192\.0\.2\.10.*20261011_init/)
    expect(rows[2]).toMatch(/failed.*x\.dump.*build failed/)
    const select = document.getElementById('rollback-to') as HTMLSelectElement
    expect([...select.options].map((o) => o.value)).toEqual(['', 'a'.repeat(40)])
    click('Roll back…')
    await confirmDialog('Roll back')
    await until(() => has('another deploy is running'))
    expect(has('held by pid 5100 on server-1, bob, run (run 20261011T120000Z-0123456789ab)')).toBe(true)
    select.value = 'a'.repeat(40)
    click('Roll back…')
    await until(() => document.querySelector('dialog')?.textContent?.includes('Back to aaaaaaaaaaaa.') === true)
    await confirmDialog('Roll back')
    await until(() => document.getElementById('run-title')?.textContent === `rollback ${RUN}`)
    expect(sent.filter((s) => s.route === 'rollback').at(-1)?.body).toEqual({ target: 'staging', confirm: true, confirmedTarget: targets.targets[0], to: 'a'.repeat(40) })
    await until(() => has('The stream ended.'))
    click('Refresh status')
    await until(() => has('Current release'))
  })

  it('quit asks first; declining keeps everything', async () => {
    routes['quit'] = () => json({ ok: true })
    await start()
    click('Quit')
    await confirmDialog('Cancel')
    expect(sent.some((s) => s.route === 'quit')).toBe(false)
    click('Quit')
    await confirmDialog('Quit')
    await until(() => has('has stopped'))
  })
})

describe('reply banners', () => {
  it('an exit code without an error event, nothing at all, a plain error', () => {
    expect(problem({ ok: false, exitCode: 2, diagnostics: [] })?.textContent).toMatch(/The command failed.*exit code 2/s)
    expect(problem({ ok: true, diagnostics: [] })).toBeNull()
    expect(problem(undefined)).toBeNull()
    expect(problem(undefined, new Error('plain'))?.textContent).toMatch(/plain/)
    expect(problem(undefined, 'text')?.textContent).toMatch(/text/)
    expect(problem(undefined, new ApiError(409, 'busy'))?.textContent).toMatch(/busy \(HTTP 409\)/)
  })
})
