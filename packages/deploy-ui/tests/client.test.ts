// @vitest-environment jsdom
import { createHmac, webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Api, ApiError, PROOF_CONTEXT, readLines, ServerGone, type Fetch } from '../src/client/api.js'
import { SERVER_KEY, TOKEN_KEY, type App } from '../src/client/app.js'
import { confirmDialog } from '../src/client/dialog.js'
import { el, text } from '../src/client/dom.js'
import { boot, type Env } from '../src/client/main.js'
import type { StreamMessage, TargetView } from '../src/client/messages.js'
import { clean } from '../src/client/sanitize.js'
import { MAX_LOG_LINES, RunView } from '../src/client/view-run.js'
import { INDEX_HTML } from '../src/page.js'
import { startUiServer, type UiServer } from '../src/server.js'
import { PROOF_CONTEXT as SERVER_PROOF_CONTEXT } from '../src/session.js'
import { control, type Control } from './helpers.js'

/**
 * The browser code in jsdom: against the REAL local server and the fake ssh
 * for the flows (so the page and the server are tested together), and
 * against a scripted fetch for the edges.
 */

const SECRET = 'sk_live_UI_SECRET_5b1d'
const CRYPTO = webcrypto as unknown as Crypto
const RUN = '20261011T120000Z-aaaaaaaaaaa2'
let ssh: Control
let home: string
let ui: UiServer

const until = async (check: () => boolean, what = 'condition', ms = 10_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${document.body.textContent?.slice(0, 2000)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}
const buttons = (label: string | RegExp) => [...document.querySelectorAll('button')].filter((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')))
const click = (label: string | RegExp) => {
  const found = buttons(label)[0]
  if (!found) throw new Error(`no button ${label}: ${[...document.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  found.click()
}
const dialog = () => document.querySelector('dialog')
const confirmOpen = async (label: string) => {
  await until(() => dialog() !== null, 'a dialog')
  ;[...(dialog() as HTMLDialogElement).querySelectorAll('button')].find((b) => b.textContent === label)?.click()
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement
const type = (id: string, value: string) => { input(id).value = value }

function shell(): void {
  // The real page's body (test code may parse HTML; the client never does).
  document.documentElement.innerHTML = INDEX_HTML.replace(/^<!doctype html>\n/, '')
}

/** fetch as the browser would send it: our origin, relative URLs. */
// Like a browser, retry once when a pooled keep-alive socket turns out to be
// dead: Node's fetch can reuse a socket the stopped server has just destroyed
// (seen on Linux CI), and a browser would transparently reconnect.
const browserFetch = (server: UiServer): Fetch => async (input, init) => {
  const send = (): Promise<Response> => fetch(`http://127.0.0.1:${server.port}${input}`, {
    ...init, headers: { ...(init.headers as Record<string, string>), Origin: `http://127.0.0.1:${server.port}`, 'Sec-Fetch-Site': 'same-origin' },
  })
  try {
    return await send()
  } catch (error) {
    if (init.signal?.aborted) throw error
    return send()
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'basalt-deploy-ui-client-'))
  ssh = await control({
    'staging.example.com': {
      status: { transcript: 'status-ok' },
      plan: { transcript: 'plan-questions' },
      run: { transcript: 'run-detach' },
      env: { transcript: 'env-answers' },
      attach: { transcript: 'attach-from-0' },
    },
    'prod.example.com': { status: { transcript: 'status-ok' }, rollback: { transcript: 'rollback-detach' }, attach: { transcript: 'attach-not-found' } },
  })
})
afterAll(async () => {
  await ui?.close()
  await ssh.cleanup()
  await rm(home, { recursive: true, force: true })
})

describe('the page against the real local server', () => {
  let app: App
  let replaced: string | undefined

  it('boots from the launch code, removes it from the address bar, keeps the token in this tab only', async () => {
    ui = await startUiServer({ targetsPath: join(home, 'targets.json'), runner: ssh.runner, osUser: 'alice', clientDir: null, log: () => undefined, follow: { sleep: async () => undefined } })
    shell()
    sessionStorage.clear()
    const env: Env = {
      location: { hash: `#launch=${ui.launchUrl.split('#launch=')[1]}`, pathname: '/' },
      history: { replaceState: (_d, _u, url) => { replaced = url } },
      storage: sessionStorage,
      fetch: browserFetch(ui),
      document,
      crypto: CRYPTO,
    }
    app = await boot(env) as App
    expect(app).toBeDefined()
    expect(replaced).toBe('/')
    expect(sessionStorage.getItem(TOKEN_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(sessionStorage.getItem(SERVER_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // First launch, no target: the add form is open.
    expect(document.getElementById('target-name')).not.toBeNull()
  })

  it('the add-target form shows the server\'s refusals by field, then saves', async () => {
    type('target-name', 'staging')
    type('target-ssh', '-oProxyCommand=x')
    type('target-dir', '/srv/myapp')
    click('Save')
    await until(() => (document.getElementById('target-ssh-error')?.textContent ?? '') !== '', 'the ssh field error')
    expect(input('target-ssh').getAttribute('aria-describedby')).toContain('target-ssh-error')
    type('target-ssh', 'deploy@staging.example.com')
    click('Save')
    await until(() => document.querySelector('table td')?.textContent === 'staging', 'the saved target')
    click('Add a target')
    type('target-name', 'production')
    type('target-ssh', 'deploy@prod.example.com')
    type('target-dir', '/srv/myapp')
    input('target-protected').checked = true
    click('Save')
    await until(() => [...document.querySelectorAll('td')].some((td) => td.textContent === 'production'), 'production')
  })

  it('status: the release, the process, the bar with host and app', async () => {
    click('Use')
    await until(() => document.body.textContent?.includes('Current release') === true && document.querySelector('.target-bar')?.textContent?.includes('app acme') === true, 'status')
    expect(document.querySelector('.target-bar')?.textContent).toContain('staging · deploy@staging.example.com · /srv/myapp · host server-1')
    expect(document.body.textContent).toContain('bbbbbbbbbbbb')
    expect(document.body.textContent).toContain('pm2 acme-api: running')
  })

  it('plan → the .env form (secret as password, emptied after sending) → deploy → the live run', async () => {
    click('Plan & deploy')
    click('Run plan')
    await until(() => document.getElementById('q-0') !== null, 'the questions')
    const secret = input('q-0')
    expect(secret.type).toBe('password')
    expect(secret.getAttribute('autocomplete')).toBe('off')
    expect(secret.value).toBe('')
    expect(input('q-1').value).toBe('help@example.com')
    secret.value = SECRET
    // Declined: nothing sent, the value still in the field for another try.
    ;(document.querySelector('form[aria-label="Deploy"]') as HTMLFormElement).requestSubmit()
    await confirmOpen('Cancel')
    expect(dialog()).toBeNull()
    expect(secret.value).toBe(SECRET)
    ;(document.querySelector('form[aria-label="Deploy"]') as HTMLFormElement).requestSubmit()
    await until(() => dialog() !== null)
    expect(dialog()?.textContent).toContain('staging.example.com')
    await confirmOpen('Deploy')
    await until(() => document.getElementById('run-title')?.textContent === `run ${RUN}`, 'the run view')
    await until(() => document.body.textContent?.includes('Finished: exit 0') === true, 'the end of the run')
    expect(secret.value).toBe('')
    expect([...document.querySelectorAll('.steps li')].map((li) => li.textContent?.split(' —')[0])).toContain('✓ release')
    expect(document.querySelectorAll('.log li').length).toBeGreaterThan(10)
    // The secret is nowhere in the page or the tab's storage.
    expect(document.documentElement.outerHTML).not.toContain(SECRET)
    for (let i = 0; i < sessionStorage.length; i++) expect(sessionStorage.getItem(sessionStorage.key(i) as string)).not.toContain(SECRET)
    expect(sessionStorage.getItem(`basalt-deploy-ui:seq:${RUN}`)).toBe('45')
    const call = (await ssh.calls()).find((c) => c.words[6] === 'run')
    expect(call?.stdin).toContain(SECRET)
    expect(call?.words).toContain('--actor=alice')
  })

  it('history and a protected rollback: the name must be typed', async () => {
    const select = document.querySelector('nav select') as HTMLSelectElement
    select.value = 'production'
    select.dispatchEvent(new Event('change'))
    await until(() => document.querySelector('.target-bar')?.textContent?.includes('PROTECTED') === true && document.querySelector('.target-bar')?.textContent?.includes('app acme') === true, 'production status')
    click('History')
    expect(document.querySelectorAll('tbody tr').length).toBe(2)
    click('Roll back…')
    await until(() => dialog() !== null)
    const confirm = [...(dialog() as HTMLDialogElement).querySelectorAll('button')].find((b) => b.textContent === 'Roll back') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    const name = input('confirm-name')
    name.value = 'staging'
    name.dispatchEvent(new Event('input'))
    expect(confirm.disabled).toBe(true)
    name.value = 'production'
    name.dispatchEvent(new Event('input'))
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await until(() => document.getElementById('run-title')?.textContent?.startsWith('rollback ') === true, 'the rollback view')
    await until(() => document.body.textContent?.includes('not-found') === true, 'the attach error')
    const call = (await ssh.calls()).find((c) => c.words[6] === 'rollback')
    expect(call?.words).toEqual(expect.arrayContaining(['--detach', '--via=ui']))
  })

  it('a page reload reuses the tab\'s token; quit stops the server', async () => {
    shell()
    const again = await boot({ location: { hash: '', pathname: '/' }, history: { replaceState: () => undefined }, storage: sessionStorage, fetch: browserFetch(ui), document, crypto: CRYPTO }) as App
    expect(again.targets.targets.map((t) => t.name)).toEqual(['staging', 'production'])
    click('Quit')
    await confirmOpen('Quit')
    await until(() => document.body.textContent?.includes('has stopped') === true, 'stopped')
    await expect(fetch(ui.url)).rejects.toThrow()
    // Quit forgets the tab's session.
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(sessionStorage.getItem(SERVER_KEY)).toBeNull()
  })
})

describe('the page on its own', () => {
  beforeEach(() => { shell(); sessionStorage.clear() })

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('a second claim of the session fails loudly; no code and no token says what to do', async () => {
    const env = (hash: string, fetchImpl: Fetch): Env => ({ location: { hash, pathname: '/' }, history: { replaceState: () => undefined }, storage: sessionStorage, fetch: fetchImpl, document, crypto: CRYPTO })
    expect(await boot(env('#launch=abc', async () => new Response('this UI already has its browser session\n', { status: 409, headers: { 'content-type': 'text/plain' } })))).toBeUndefined()
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/already has its browser session.*stop basalt-deploy-ui/s)
    shell()
    expect(await boot(env('#launch=abc', async () => new Response('wrong launch code', { status: 401 })))).toBeUndefined()
    expect(document.body.textContent).toMatch(/launch code was refused/)
    shell()
    expect(await boot(env('', async () => json(200, {})))).toBeUndefined()
    expect(document.body.textContent).toMatch(/No session/)
    shell()
    // A token without its server key (or the reverse) is no session: both are forgotten.
    sessionStorage.setItem(TOKEN_KEY, 'tok')
    expect(await boot(env('', async () => json(200, {})))).toBeUndefined()
    expect(document.body.textContent).toMatch(/No session/)
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    shell()
    const key = Buffer.alloc(32, 9).toString('base64url')
    const proving: Fetch = async (input, init) => {
      if (input === '/api/hello') {
        const { nonce } = JSON.parse(String(init.body)) as { nonce: string }
        return json(200, { proof: createHmac('sha256', Buffer.from(key, 'base64url')).update(`${PROOF_CONTEXT}${nonce}`).digest('base64url') })
      }
      return json(401, { error: 'no session' })
    }
    sessionStorage.setItem(TOKEN_KEY, 'tok')
    sessionStorage.setItem(SERVER_KEY, key)
    expect(await boot(env('', proving))).toBeUndefined()
    expect(document.body.textContent).toMatch(/could not start.*no session/s)
    // A server that cannot prove the key: the page stops before anything else, and forgets the session.
    shell()
    expect(await boot(env('', async () => json(200, { proof: 'A'.repeat(43) })))).toBeUndefined()
    expect(document.body.textContent).toMatch(/no longer talks to your deploy UI/)
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
  })

  it('after the UI stops, a listener that takes its port gets no answer: the page asks for the proof first, then stops and forgets', async () => {
    const server = await startUiServer({ targetsPath: join(home, 'squat-targets.json'), runner: ssh.runner, clientDir: null, log: () => undefined })
    const app = await boot({
      location: { hash: `#launch=${server.launchUrl.split('#launch=')[1]}`, pathname: '/' }, history: { replaceState: () => undefined },
      storage: sessionStorage, fetch: browserFetch(server), document, crypto: CRYPTO,
    }) as App
    expect(app).toBeDefined()
    // The real server proves itself, as often as asked.
    await app.api.verifyServer()
    await app.api.verifyServer()
    // It stops (idle, Ctrl-C); another local user's process binds the same port and answers everything.
    await server.close()
    const seen: Array<{ url: string | undefined; auth: string | undefined; body: string }> = []
    const squatter = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ proof: 'A'.repeat(43), ok: true, token: 'x' }))
      })
    })
    await new Promise<void>((resolve, reject) => { squatter.once('error', reject); squatter.listen(server.port, '127.0.0.1', () => resolve()) })
    try {
      const error = await app.api.post('run', { target: 'prod', confirm: true, answers: [{ id: 'env.DATABASE_PASSWORD', value: SECRET }] }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ServerGone)
      expect((error as ServerGone).why).toBe('unverified')
      // It saw a hello with a nonce, and nothing else: never the answer.
      expect(seen.map((r) => r.url)).toEqual(['/api/hello'])
      expect(JSON.stringify(seen)).not.toContain(SECRET)
      expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/no longer talks to your deploy UI.*Nothing was sent/s)
      expect(document.querySelector('form')).toBeNull()
      expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
      expect(sessionStorage.getItem(SERVER_KEY)).toBeNull()
      // Nothing more leaves the page.
      await expect(app.api.post('targets')).rejects.toBeInstanceOf(ServerGone)
      await expect(app.api.stream('attach', {}, () => undefined)).rejects.toBeInstanceOf(ServerGone)
      expect(seen).toHaveLength(1)
    } finally {
      await new Promise((r) => squatter.close(r))
    }
  })

  it('a stopped UI (nothing on the port) turns the page into a "stopped" notice, with the session forgotten', async () => {
    const server = await startUiServer({ targetsPath: join(home, 'stop-targets.json'), runner: ssh.runner, clientDir: null, log: () => undefined })
    const app = await boot({
      location: { hash: `#launch=${server.launchUrl.split('#launch=')[1]}`, pathname: '/' }, history: { replaceState: () => undefined },
      storage: sessionStorage, fetch: browserFetch(server), document, crypto: CRYPTO,
    }) as App
    await server.close()
    const error = await app.api.post('status', { target: 'staging' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ why: 'unreachable' })
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/The deploy UI has stopped/)
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(document.getElementById('nav')?.childElementCount).toBe(0)
  })

  it('the proof: the same context string on both sides; no key, no WebCrypto or a refusal stops the page; a stream cut is a stop, a page bug is not', async () => {
    expect(PROOF_CONTEXT).toBe(SERVER_PROOF_CONTEXT)
    const answers = { answers: [{ id: 'env.A', value: 'x' }] }
    const sent: string[] = []
    const record: Fetch = async (input) => { sent.push(input); return json(200, {}) }
    for (const api of [new Api('tok', record), new Api('tok', record, { serverKey: 'k' }), new Api('tok', record, { crypto: CRYPTO })]) {
      await expect(api.post('run', answers)).rejects.toMatchObject({ why: 'unverified' })
    }
    expect(sent).toEqual([])
    // Without answers, no proof is needed.
    await new Api('tok', record).post('run', { answers: [] })
    expect(sent).toEqual(['/api/run'])
    const refusing = new Api('tok', async () => json(401, { error: 'no session' }), { serverKey: 'k', crypto: CRYPTO })
    let gone: ServerGone | undefined
    refusing.onGone = (e) => { gone = e }
    await expect(refusing.stream('env', answers, () => undefined)).rejects.toMatchObject({ why: 'unverified' })
    expect(gone?.why).toBe('unverified')

    const cut = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"kind":"state","state":"connecting"}\n')); c.error(new TypeError('network error')) } })
    await expect(new Api('tok', async () => new Response(cut, { status: 200 })).stream('attach', {}, () => undefined)).rejects.toMatchObject({ why: 'unreachable' })
    const bug = new Api('tok', async () => new Response('{"kind":"diagnostic","text":"x"}\n', { status: 200 }))
    let bugGone: ServerGone | undefined
    bug.onGone = (e) => { bugGone = e }
    await expect(bug.stream('attach', {}, () => { throw new RangeError('a page bug') })).rejects.toBeInstanceOf(RangeError)
    expect(bugGone).toBeUndefined()
    const aborted = new AbortController()
    aborted.abort()
    await expect(new Api('tok', async (_i, init) => { if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError'); return json(200, {}) }).stream('attach', {}, () => undefined, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('the API client: bearer header, JSON errors, text errors, NDJSON split anywhere', async () => {
    const seen: RequestInit[] = []
    const api = new Api('tok', async (_input, init) => { seen.push(init); return json(422, { error: 'refused', errors: { ssh: 'bad' } }) })
    const error = await api.post('targets/save').catch((e: unknown) => e) as ApiError
    expect(error).toBeInstanceOf(ApiError)
    expect(error.body['errors']).toEqual({ ssh: 'bad' })
    expect(seen[0]).toMatchObject({ method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' } })
    const plain = new Api('tok', async () => new Response('wrong Origin', { status: 403 }))
    await expect(plain.post('x')).rejects.toThrow('wrong Origin')
    const encoder = new TextEncoder()
    const bytes = encoder.encode('{"kind":"diagnostic","text":"é"}\nnot json\n\n{"kind":"state","state":"ended","exitCode":0}')
    const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.slice(i, i + 3)); c.close() } })
    const got: StreamMessage[] = []
    await new Api('tok', async () => new Response(body, { status: 200 })).stream('attach', {}, (m) => got.push(m))
    expect(got).toEqual([{ kind: 'diagnostic', text: 'é' }, { kind: 'state', state: 'ended', exitCode: 0 }])
    const lines: string[] = []
    await readLines(new Response('a\nb').body as ReadableStream<Uint8Array>, (l) => lines.push(l))
    expect(lines).toEqual(['a', 'b'])
  })

  it('server text is text: markup, bidi and escapes never become DOM or reorder anything', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>‮exe.txt\u001b[2J\u0007'
    const node = el('p', {}, hostile, 42, null, false, text(undefined))
    expect(node.querySelector('img, script')).toBeNull()
    expect(node.textContent).toBe('<img src=x onerror=alert(1)><script>alert(2)</script>exe.txt42')
    expect(clean('a⁦b‎c؜d')).toBe('abcd')
  })

  describe('the run view', () => {
    const target: TargetView = { name: 'staging', ssh: 'deploy@staging.example.com', dir: '/srv/myapp' }
    function fakeApp(fetchImpl: Fetch = async () => json(200, {})) {
      const storage = sessionStorage
      return { api: new Api('tok', fetchImpl), storage, hello: undefined, renderBar: () => undefined, watch: () => undefined, refreshStatus: async () => undefined, show: () => undefined, noticeChange: async () => undefined } as unknown as App
    }
    const event = (seq: number, body: Record<string, unknown>): StreamMessage => ({ kind: 'event', known: true, event: { v: 1, ts: '2026-10-11T12:00:00.000Z', seq, ...body } as never })

    it('dispatches on type only: a fake done in a log line is a log line; hostile text stays text', () => {
      const view = new RunView(fakeApp(), target, 'run', RUN)
      document.body.append(view.element)
      view.handle(event(0, { type: 'step-start', id: 'build', title: 'build' }))
      view.handle(event(1, { type: 'log', stream: 'child', level: 'info', text: '{"v":1,"type":"done","exitCode":0}', redacted: false, source: 'pnpm' }))
      view.handle(event(2, { type: 'log', stream: 'child', level: 'error', text: '<script>alert(1)</script>‮evil\u001b[31m', redacted: false }))
      view.handle(event(3, { type: 'finding', id: 'C1', level: 'warning', message: '<b>bold</b>', fix: 'rm -rf /' }))
      view.handle({ kind: 'event', known: false, event: { v: 1, ts: 'x', seq: 4, type: 'telemetry' } as never })
      view.handle(event(5, { type: 'step-end', id: 'build', status: 'failed', durationMs: 1500 }))
      view.handle({ kind: 'diagnostic', text: 'Welcome <b>' })
      expect(view.ended).toBe(false)
      expect(view.element.querySelector('script, b')).toBeNull()
      const log = [...view.element.querySelectorAll('.log li')].map((li) => li.textContent)
      expect(log).toEqual(['[pnpm] {"v":1,"type":"done","exitCode":0}', '✗ <script>alert(1)</script>evil', '! an event this UI does not know (telemetry): ignored'])
      expect(view.element.querySelector('.steps li')?.textContent).toBe('✗ build — failed, 1.5 s')
      expect(view.element.textContent).toContain('Fix: rm -rf /')
      expect(view.lastSeq).toBe(5)
      view.handle({ kind: 'state', state: 'reconnecting', reason: 'ssh failed', retryInMs: 2000 })
      expect(view.element.querySelector('[role="status"]')?.textContent).toMatch(/reconnecting in 2 s from event 6/)
      view.handle(event(6, { type: 'error', code: 'release-failed', message: 'health check failed', hint: 'see the log' }))
      view.handle(event(7, { type: 'done', exitCode: 1 }))
      view.handle({ kind: 'state', state: 'ended', exitCode: 1 })
      expect(view.ended).toBe(true)
      expect(view.element.textContent).toContain('health check failed')
      expect(view.element.textContent).toContain('Finished with exit 1')
    })

    it('keeps the last 5,000 log lines in the page', () => {
      const view = new RunView(fakeApp(), target, 'run', undefined)
      for (let i = 0; i < MAX_LOG_LINES + 25; i++) view.handle(event(i, { type: 'log', stream: 'tool', level: 'info', text: `line ${i}`, redacted: false }))
      expect(view.element.querySelectorAll('.log li').length).toBe(MAX_LOG_LINES)
      expect(view.element.querySelector('.log li')?.textContent).toBe('line 25')
    })

    it('resumes from the seq this tab saw; a dropped stream offers re-attach', async () => {
      sessionStorage.setItem(`basalt-deploy-ui:seq:${RUN}`, '9')
      const bodies: unknown[] = []
      const view = new RunView(fakeApp(async (_i, init) => {
        bodies.push(JSON.parse(String(init.body)))
        return new Response(`${JSON.stringify({ kind: 'state', state: 'ended', code: 'disconnected', reason: 'the connection kept dropping', hint: 're-attach later' })}\n`, { status: 200 })
      }), target, 'run', RUN)
      document.body.append(view.element)
      expect(view.resumeSeq()).toBe(10)
      await view.attach(view.resumeSeq())
      expect(bodies[0]).toEqual({ target: 'staging', runId: RUN, fromSeq: 10 })
      expect(view.element.textContent).toContain('the connection kept dropping')
      expect(buttons('Re-attach')).toHaveLength(1)
      sessionStorage.setItem(`basalt-deploy-ui:seq:${RUN}`, 'junk')
      expect(view.resumeSeq()).toBe(0)
    })

    it('a resumed attach names a step that started before the resume point by its id', () => {
      const view = new RunView(fakeApp(), target, 'run', RUN)
      view.handle(event(20, { type: 'step-end', id: 'build', status: 'failed', durationMs: 1200 }))
      expect(view.element.querySelector('.steps li')?.textContent).toBe('✗ build — failed, 1.2 s')
    })

    it('a run whose done was seen offers a replay, never a re-attach (it would only find the end again)', async () => {
      const view = new RunView(fakeApp(async () => new Response(`${JSON.stringify({ kind: 'state', state: 'ended', exitCode: 0, reason: 'the run had already finished' })}\n`, { status: 200 })), target, 'run', RUN)
      document.body.append(view.element)
      await view.attach(47)
      expect(view.element.textContent).toContain('the run had already finished')
      expect(view.element.textContent).toContain('Finished: exit 0')
      expect(buttons('Re-attach')).toHaveLength(0)
      expect(buttons('Show from the start')[0]?.className).toBe('primary')
      view.element.remove()
      // Seen as the run's own done event in the stream, the same.
      const live = new RunView(fakeApp(async () => new Response([
        JSON.stringify(event(45, { type: 'done', exitCode: 1 })),
        JSON.stringify({ kind: 'state', state: 'ended', exitCode: 1 }),
      ].join('\n'), { status: 200 })), target, 'run', RUN)
      document.body.append(live.element)
      await live.attach(45)
      expect(buttons('Re-attach')).toHaveLength(0)
      live.element.remove()
    })

    it('cancel: two separate confirmations, the second one warns about a half-applied migration', async () => {
      const sent: Array<Record<string, unknown>> = []
      let streamClose: (() => void) | undefined
      const fetchImpl: Fetch = async (input, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (input === '/api/attach') {
          return new Response(new ReadableStream({ start(c) { streamClose = () => c.close() } }), { status: 200 })
        }
        sent.push(body)
        if (body['second'] !== true && sent.length > 1) return json(428, { error: 'already cancelled once', second: true })
        return json(200, { ok: true, result: { runId: RUN, pid: 5100, signal: 'SIGTERM', second: body['second'] === true }, diagnostics: [] })
      }
      const view = new RunView(fakeApp(fetchImpl), target, 'run', RUN)
      document.body.append(view.element)
      const attached = view.attach(0)
      await until(() => buttons('Cancel…').length === 1, 'the cancel button')
      click('Cancel…')
      await until(() => dialog() !== null)
      expect(dialog()?.textContent).toMatch(/next step boundary before the migration/)
      await confirmOpen('Cancel')
      expect(sent).toEqual([])
      click('Cancel…')
      await confirmOpen('Cancel the run')
      await until(() => sent.length === 1)
      expect(sent[0]).toEqual({ target: 'staging', runId: RUN, confirm: true })
      await until(() => buttons(/Cancel again/).length === 1)
      click(/Cancel again/)
      await until(() => dialog() !== null)
      expect(dialog()?.textContent).toMatch(/A migration may be left half-applied/)
      await confirmOpen('Stop it now')
      await until(() => sent.length === 2)
      expect(sent[1]).toEqual({ target: 'staging', runId: RUN, confirm: true, second: true })
      // A server that already counted a cancel (another tab) asks for the second confirmation too.
      const fresh = new RunView(fakeApp(fetchImpl), target, 'run', RUN)
      document.body.append(fresh.element)
      void fresh.cancel(false)
      await confirmOpen('Cancel the run')
      await until(() => dialog()?.textContent?.includes('half-applied') === true, 'the second dialog')
      await confirmOpen('Stop it now')
      await until(() => sent.length === 4)
      expect(sent.slice(2)).toEqual([{ target: 'staging', runId: RUN, confirm: true }, { target: 'staging', runId: RUN, confirm: true, second: true }])
      streamClose?.()
      await attached
    })
  })

  it('a destructive dialog opens with focus on Cancel, never on the destructive button; a typed name takes focus when asked', async () => {
    const danger = confirmDialog({ title: 'Stop the deploy NOW?', lines: [], confirmLabel: 'Stop it now', danger: true })
    expect(document.activeElement?.textContent).toBe('Cancel')
    ;(document.activeElement as HTMLButtonElement).click()
    expect(await danger).toBe(false)
    const typed = confirmDialog({ title: 'Deploy?', lines: [], confirmLabel: 'Deploy', danger: true, typeToConfirm: 'production' })
    expect(document.activeElement?.id).toBe('confirm-name')
    dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await typed).toBe(false)
    const mild = confirmDialog({ title: 'Quit?', lines: [], confirmLabel: 'Quit' })
    expect(document.activeElement?.textContent).toBe('Quit')
    dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await mild).toBe(false)
  })

  it('a dialog cancels on Escape and needs the exact name when asked', async () => {
    const answer = confirmDialog({ title: 'Deploy?', lines: ['x'], confirmLabel: 'Go', typeToConfirm: 'production' })
    dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(await answer).toBe(false)
    expect(dialog()).toBeNull()
  })
})
