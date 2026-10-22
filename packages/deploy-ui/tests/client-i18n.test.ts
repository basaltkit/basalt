// @vitest-environment jsdom
import { createHmac, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlanResult, StatusResult } from '@basaltkit/deploy/protocol'
import { Api, PROOF_CONTEXT, type Fetch } from '../src/client/api.js'
import { App } from '../src/client/app.js'
import { setLocale } from '../src/client/i18n.js'
import { boot } from '../src/client/main.js'
import type { CommandReply, TargetsReply } from '../src/client/messages.js'
import { INDEX_HTML } from '../src/page.js'

/**
 * The page in Portuguese: from the targets file, from the browser's language
 * before a session exists, and from the switcher — which re-renders in place
 * and keeps the choice. What the server's deploy prints stays as it came.
 */

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const hello = { v: 1, ts: '2026-10-11T12:00:00.000Z', seq: 0, type: 'hello', tool: '@basaltkit/deploy', version: '0.8.0', protocol: 1, command: 'status', pid: 1, host: 'server-1' } as const
const targetsReply = (over: Partial<TargetsReply> = {}): TargetsReply => ({
  path: '/home/alice/.config/basalt/deploy-targets.json', exists: true, actor: 'alice',
  targets: [{ name: 'staging', ssh: 'deploy@staging.example.com', dir: '/srv/myapp' }],
  ...over,
})
const status: StatusResult = {
  app: 'myapp', stateDir: '/srv/myapp/.basalt', lock: null, hold: null,
  releases: [{ sha: 'b'.repeat(40), at: '2026-10-11T12:00:00.000Z', user: 'deploy', status: 'ok', migrations: [] }, { sha: 'c'.repeat(40), at: '2026-10-10T12:00:00.000Z', user: 'deploy', status: 'failed', migrations: [] }],
  process: { kind: 'pm2', name: 'myapp-api', running: true, pid: 42 },
}
const plan: PlanResult = { findings: [{ id: 'C2', level: 'error', message: 'the tree is dirty', fix: 'git stash' }], lines: [{ step: 'build', text: 'pnpm build' }], questions: [], blocking: true }
const reply = (result: unknown): CommandReply => ({ ok: true, hello: hello as never, result, exitCode: 0, diagnostics: [] })

const SERVER_KEY = Buffer.alloc(32, 7).toString('base64url')
const CRYPTO = webcrypto as unknown as Crypto
const prove = (body: Record<string, unknown>) => json({ proof: createHmac('sha256', Buffer.from(SERVER_KEY, 'base64url')).update(`${PROOF_CONTEXT}${String(body['nonce'])}`).digest('base64url') })

let routes: Record<string, Handler>
let sent: Array<{ route: string; body: Record<string, unknown> }>
const fetchImpl: Fetch = async (input, init) => {
  const route = input.replace('/api/', '')
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  sent.push({ route, body })
  const handler = routes[route]
  return handler ? handler(body) : json({ error: `no route ${route}` }, 404)
}

const main = () => document.getElementById('app') as HTMLElement
const nav = () => [...document.querySelectorAll('.nav-item')].map((b) => b.textContent)
const until = async (check: () => boolean, what = 'condition') => {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${document.body.textContent?.slice(0, 1500)}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const click = (label: string) => {
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!button) throw new Error(`no button ${label}: ${[...document.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`)
  button.click()
}
const shell = () => { document.documentElement.innerHTML = INDEX_HTML.replace(/^<!doctype html>\n/, '') }

async function start(): Promise<App> {
  shell()
  const app = new App(new Api('tok', fetchImpl, { serverKey: SERVER_KEY, crypto: CRYPTO }), {
    nav: document.getElementById('nav') as HTMLElement,
    bar: document.getElementById('target-bar') as HTMLElement,
    main: main(),
    session: document.getElementById('session') as HTMLElement,
  }, sessionStorage)
  await app.start()
  return app
}

beforeEach(() => {
  sent = []
  sessionStorage.clear()
  routes = { hello: prove, targets: () => json(targetsReply()), status: () => json(reply(status)), plan: () => json(reply(plan)) }
})
afterEach(() => setLocale('en', []))

describe('the page in Portuguese', () => {
  it('the targets file\'s language: every screen, the shell and the bar speak it; the deploy\'s own text stays as it came', async () => {
    routes['targets'] = () => json(targetsReply({ locale: 'pt' }))
    const app = await start()
    await until(() => main().textContent?.includes('Release actual') === true, 'the status in Portuguese')
    expect(document.documentElement.lang).toBe('pt')
    expect(document.getElementById('nav')?.getAttribute('aria-label')).toBe('Ecrãs')
    expect(document.querySelector('.local-label')?.textContent).toBe('Só local')
    expect(nav()).toEqual(['Estado', 'Plano e deploy', 'Histórico', 'Execução', 'Destinos'])
    expect(main().textContent).toContain('saudável')
    expect(document.querySelector('.target-bar')?.textContent).toBe('staging · deploy@staging.example.com · /srv/myapp · host server-1 · deploy 0.8.0 · app myapp')
    expect((document.getElementById('locale-select') as HTMLSelectElement).value).toBe('pt')

    app.show('history')
    expect(main().textContent).toContain('As últimas 10 releases')
    expect([...document.querySelectorAll('.releases th')].map((th) => th.textContent)).toContain('Quando')
    expect([...document.querySelectorAll('.releases .pill')].map((p) => p.textContent)).toEqual(['ok', 'falhou'])

    app.show('plan')
    click('Correr o plan')
    await until(() => main().textContent?.includes('Verificações') === true, 'the plan in Portuguese')
    // The deploy's finding and step are its own words; only the page's frame is translated.
    expect(main().textContent).toContain('the tree is dirty')
    expect(main().textContent).toContain('pnpm build')
    expect(main().textContent).toContain('1 erro, 0 avisos')
    expect(main().textContent).toContain('O plano encontrou problemas que impedem uma execução')
    expect(sent.some((s) => s.route === 'targets/save')).toBe(false)
  })

  it('the switcher re-renders in place and keeps the choice in the targets file; back to English the same way', async () => {
    let saved: unknown
    routes['targets/save'] = (body) => { saved = body['locale']; return json(targetsReply({ locale: body['locale'] as 'pt' })) }
    await start()
    await until(() => main().textContent?.includes('Current release') === true, 'the status')
    expect(nav()[0]).toBe('Status')
    const select = document.getElementById('locale-select') as HTMLSelectElement
    expect([...select.options].map((o) => [o.value, o.textContent, o.lang])).toEqual([['en', 'English', 'en'], ['pt', 'Português', 'pt']])
    select.value = 'pt'
    select.dispatchEvent(new Event('change'))
    expect(nav()[0]).toBe('Estado')
    expect(main().textContent).toContain('Release actual')
    expect(document.documentElement.lang).toBe('pt')
    expect([...document.querySelectorAll('#session button')].map((b) => b.textContent)).toEqual(['Sair'])
    await until(() => saved === 'pt', 'the choice saved')
    const again = document.getElementById('locale-select') as HTMLSelectElement
    again.value = 'en'
    again.dispatchEvent(new Event('change'))
    expect(nav()[0]).toBe('Status')
    await until(() => saved === 'en', 'English saved')
  })

  it('a failed save still switches this tab', async () => {
    routes['targets/save'] = () => json({ error: 'the targets file is not yours' }, 409)
    await start()
    await until(() => main().textContent?.includes('Current release') === true, 'the status')
    const select = document.getElementById('locale-select') as HTMLSelectElement
    select.value = 'pt'
    select.dispatchEvent(new Event('change'))
    await until(() => sent.some((s) => s.route === 'targets/save'), 'the save')
    expect(nav()[0]).toBe('Estado')
  })

  it('the local server\'s refusals of a target field are translated; its other words are shown as they came', async () => {
    routes['targets'] = () => json(targetsReply({ locale: 'pt' }))
    routes['targets/save'] = () => json({ error: 'the target is refused', errors: { ssh: '[user@]host or a Host alias from ~/.ssh/config: no spaces, no leading -, no ssh:// URL', extra: 'something new' } }, 422)
    const app = await start()
    app.show('targets')
    click('Adicionar um destino')
    ;(document.getElementById('target-name') as HTMLInputElement).value = 'staging2'
    ;(document.getElementById('target-ssh') as HTMLInputElement).value = '-oProxyCommand=x'
    ;(document.getElementById('target-dir') as HTMLInputElement).value = '/srv/myapp'
    click('Guardar')
    await until(() => (document.getElementById('target-ssh-error')?.textContent ?? '') !== '', 'the ssh error')
    expect(document.getElementById('target-ssh-error')?.textContent).toBe('[utilizador@]host ou um alias Host do ~/.ssh/config: sem espaços, sem - inicial, sem URL ssh://')
    expect(main().textContent).toContain('extra: something new')
  })

  it('before a session exists, the browser\'s language: the pairing screen in Portuguese', async () => {
    shell()
    void boot({ location: { hash: '', pathname: '/' }, history: { replaceState: () => undefined }, storage: sessionStorage, fetch: async () => json({}), document, crypto: CRYPTO, languages: ['pt-AO', 'en'] })
    expect(document.documentElement.lang).toBe('pt')
    expect(document.body.textContent).toContain('Emparelhar esta página')
    expect(document.body.textContent).toContain('Código de emparelhamento')
    shell()
    void boot({ location: { hash: '', pathname: '/' }, history: { replaceState: () => undefined }, storage: sessionStorage, fetch: async () => json({}), document, crypto: CRYPTO, languages: ['fr-FR'] })
    expect(document.documentElement.lang).toBe('en')
    expect(document.body.textContent).toContain('Pair this page')
  })
})
