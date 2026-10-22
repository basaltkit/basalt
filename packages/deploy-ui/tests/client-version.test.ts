// @vitest-environment jsdom
import { createHmac, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { StatusResult } from '@basaltkit/deploy/protocol'
import { Api, PROOF_CONTEXT, type Fetch } from '../src/client/api.js'
import { App } from '../src/client/app.js'
import { setLocale } from '../src/client/i18n.js'
import type { CommandReply, TargetsReply } from '../src/client/messages.js'
import { behind, compareVersions, driftBanner, FEATURES, sourceText, validSource } from '../src/client/version.js'
import { INDEX_HTML } from '../src/page.js'

/**
 * A server behind the page is said plainly — what is missing and how to
 * update, the second deploy included — and every target says which app it
 * is: the app's name and where its code comes from.
 */

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const hello = (version: string) => ({ v: 1, ts: '2026-10-11T12:00:00.000Z', seq: 0, type: 'hello', tool: '@basaltkit/deploy', version, protocol: 1, command: 'status', pid: 1, host: 'server-1' }) as never
const targets: TargetsReply = { path: '/home/alice/.config/basalt/deploy-targets.json', exists: true, targets: [{ name: 'staging', ssh: 'deploy@staging.example.com', dir: '/srv/myapp' }] }
const status = (over: Partial<StatusResult> & Record<string, unknown> = {}): StatusResult => ({
  app: 'myapp', stateDir: '/srv/myapp/.basalt', lock: null, hold: null, releases: [],
  process: { kind: 'pm2', name: 'myapp-api', running: true }, ...over,
})
const reply = (version: string, result: unknown): CommandReply => ({ ok: true, hello: hello(version), result, exitCode: 0, diagnostics: [] })

const SERVER_KEY = Buffer.alloc(32, 7).toString('base64url')
const CRYPTO = webcrypto as unknown as Crypto
const prove = (body: Record<string, unknown>) => json({ proof: createHmac('sha256', Buffer.from(SERVER_KEY, 'base64url')).update(`${PROOF_CONTEXT}${String(body['nonce'])}`).digest('base64url') })

let routes: Record<string, Handler>
const fetchImpl: Fetch = async (input, init) => {
  const handler = routes[input.replace('/api/', '')]
  return handler ? handler(JSON.parse(String(init.body)) as Record<string, unknown>) : json({ error: 'no route' }, 404)
}
const main = () => document.getElementById('app') as HTMLElement
const bar = () => document.querySelector('.target-bar') as HTMLElement
const until = async (check: () => boolean, what: string) => {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${document.body.textContent?.slice(0, 1200)}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
async function start(): Promise<App> {
  document.documentElement.innerHTML = INDEX_HTML.replace(/^<!doctype html>\n/, '')
  const app = new App(new Api('tok', fetchImpl, { serverKey: SERVER_KEY, crypto: CRYPTO }), {
    nav: document.getElementById('nav') as HTMLElement, bar: document.getElementById('target-bar') as HTMLElement,
    main: main(), session: document.getElementById('session') as HTMLElement,
  }, sessionStorage)
  await app.start()
  return app
}

beforeEach(() => { sessionStorage.clear(); routes = { hello: prove, targets: () => json(targets) } })
afterEach(() => setLocale('en', []))

describe('versions', () => {
  it('compares x.y.z numerically; a pre-release is before its release; anything else is not a version', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.8.0', '0.8.0')).toBe(0)
    expect(compareVersions('0.9.0-rc.1', '0.9.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    for (const junk of ['', '0.9', 'v0.9.0', '0.9.0<script>', '1.2.3.4']) expect(compareVersions(junk, '0.9.0'), junk).toBeUndefined()
  })

  it('what a server lacks, and the version that has it all', () => {
    expect(FEATURES.map((f) => f.since)).toEqual(['0.8.0', '0.9.0'])
    expect(behind('0.7.0')).toEqual({ needed: '0.9.0', missing: FEATURES })
    expect(behind('0.8.0')).toEqual({ needed: '0.9.0', missing: [FEATURES[1]] })
    expect(behind('0.9.0-rc.1')?.needed).toBe('0.9.0')
    for (const current of ['0.9.0', '0.9.3', '1.0.0']) expect(behind(current), current).toBeUndefined()
    for (const junk of [undefined, 7, '<img src=x>', 'latest']) expect(behind(junk), String(junk)).toBeUndefined()
  })

  it('the notice: what is missing, the exact command, and the two deploys — in English and Portuguese', () => {
    const notice = driftBanner('0.7.0') as HTMLElement
    expect(notice.textContent).toContain('This server runs @basaltkit/deploy 0.7.0; this page uses features up to 0.9.0')
    expect(notice.textContent).toContain('the commit lists in Plan, History and Rollback (0.8.0)')
    expect(notice.querySelector('code')?.textContent).toBe('pnpm add -D @basaltkit/deploy@^0.9.0')
    expect(notice.textContent).toContain('that deploy still runs 0.7.0 and installs 0.9.0; the next one runs it')
    expect(notice.getAttribute('role')).toBe('status')
    setLocale('pt')
    expect(driftBanner('0.8.0')?.textContent).toContain('Indisponível até ser actualizado: a origem git da app na barra do destino (0.9.0).')
    expect(driftBanner('0.9.0')).toBeNull()
  })

  it('a source from the server is checked and cleaned; anything else is no source', () => {
    expect(validSource({ remote: 'origin', branch: 'main', url: 'github.com/acme/app' })).toEqual({ remote: 'origin', branch: 'main', url: 'github.com/acme/app' })
    for (const bad of [null, 'origin/main', { remote: 'origin' }, { remote: 1, branch: 'main' }, { remote: 'origin', branch: 'main', url: 5 }]) expect(validSource(bad), JSON.stringify(bad)).toBeUndefined()
    expect(validSource({ remote: 'origin', branch: 'main\u001b[31m', url: 'x‮' })?.branch).not.toContain('\u001b')
    expect(sourceText({ remote: 'origin', branch: 'main', url: 'github.com/acme/app' })).toBe('github.com/acme/app (main)')
    expect(sourceText({ remote: 'upstream', branch: 'release' })).toBe('upstream/release')
  })
})

describe('the page', () => {
  it('an older server: the version stands out in the bar and Status explains it; a current one says nothing', async () => {
    routes['status'] = () => json(reply('0.7.0', status()))
    const app = await start()
    await until(() => main().textContent?.includes('this page uses features up to 0.9.0') === true, 'the notice')
    expect(bar().querySelector('.ctx-item.is-behind')?.textContent).toContain('0.7.0')
    routes['status'] = () => json(reply('0.9.0', status({ source: { remote: 'origin', branch: 'main', url: 'github.com/acme/app' } })))
    await app.refreshStatus()
    expect(main().querySelector('.drift')).toBeNull()
    expect(bar().querySelector('.is-behind')).toBeNull()
    expect(bar().textContent).toContain('source github.com/acme/app (main)')
  })

  it('check connection says which app the target is, where its code comes from, and whether its deploy is behind', async () => {
    routes['status'] = () => json(reply('0.8.0', status({ app: 'lexfirma', source: { remote: 'origin', branch: 'main', url: 'github.com/acme/lexfirma' } })))
    const app = await start()
    app.show('targets')
    const check = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Check connection') as HTMLButtonElement
    check.click()
    await until(() => main().textContent?.includes('staging answers') === true, 'the answer')
    expect(main().textContent).toContain('app lexfirma · github.com/acme/lexfirma (main)')
    expect(main().textContent).toContain('this page uses features up to 0.9.0')
  })

  it('an older deploy sends no source: the bar simply has none, and the check says so', async () => {
    routes['status'] = () => json(reply('0.8.0', status()))
    const app = await start()
    await until(() => bar().textContent?.includes('myapp') === true, 'the bar')
    expect(bar().textContent).not.toContain('source')
    app.show('targets')
    ;([...document.querySelectorAll('button')].find((b) => b.textContent === 'Check connection') as HTMLButtonElement).click()
    await until(() => main().textContent?.includes('staging answers') === true, 'the answer')
    expect(main().querySelector('.banner.ok p')?.textContent).toBe('app myapp')
  })
})
