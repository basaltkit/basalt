import { Api, ApiError, exchange, ServerGone, type Credentials, type Fetch } from './api.js'
import { App, applyShell, forgetSession, SERVER_KEY, TOKEN_KEY } from './app.js'
import { el, replace } from './dom.js'
import { pickLocale, setLocale, t } from './i18n.js'
import { describe } from './reply.js'

export interface Env {
  location: { hash: string; pathname: string }
  history: { replaceState: (data: unknown, unused: string, url?: string) => void }
  storage: Storage | undefined
  fetch: Fetch
  document: Document
  /** WebCrypto: the page checks its server before sending an answer. */
  crypto: Crypto | undefined
  /** The browser's languages, most preferred first: the page's language until the operator picks one. */
  languages?: readonly string[]
}

function storageOf(win: Window): Storage | undefined {
  try {
    return win.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * The page's start: the one-time launch code from the URL fragment (removed
 * from the address bar at once) — or, with none, the pairing code typed in, exchanged for the session token and the
 * server key, kept in this tab's sessionStorage — never persistent storage,
 * never a cookie. Then the server proves it is the process that printed the
 * URL, before anything else.
 */
export async function boot(env: Env): Promise<App | undefined> {
  const doc = env.document
  const languages = env.languages ?? []
  setLocale(pickLocale(undefined, languages), languages)
  applyShell(doc)
  const shell = {
    nav: doc.getElementById('nav') as HTMLElement,
    bar: doc.getElementById('target-bar') as HTMLElement,
    main: doc.getElementById('app') as HTMLElement,
    session: doc.getElementById('session') as HTMLElement,
  }
  const match = /^#launch=([A-Za-z0-9_-]{1,128})$/.exec(env.location.hash)
  if (env.location.hash) env.history.replaceState(null, '', env.location.pathname)
  let credentials: Credentials | undefined
  try {
    const token = env.storage?.getItem(TOKEN_KEY) ?? undefined
    const serverKey = env.storage?.getItem(SERVER_KEY) ?? undefined
    if (token && serverKey) credentials = { token, serverKey }
  } catch {
    credentials = undefined
  }
  if (match) {
    try {
      credentials = keep(env, await exchange(match[1] as string, env.fetch))
    } catch (error) {
      replace(shell.main, refusal(error))
      return undefined
    }
  }
  if (!credentials) {
    forgetSession(env.storage)
    credentials = await pair(env, shell.main)
    if (!credentials) return undefined
  }
  const app = new App(new Api(credentials.token, env.fetch, { serverKey: credentials.serverKey, ...(env.crypto ? { crypto: env.crypto } : {}) }), shell, env.storage)
  try {
    await app.api.verifyServer()
    await app.start()
  } catch (error) {
    // The server is gone or not ours: the page already says so.
    if (error instanceof ServerGone) return undefined
    replace(shell.main, el('div', { class: 'banner err', role: 'alert' }, el('strong', {}, t('start.failed')), el('p', {}, describe(error))))
    return undefined
  }
  return app
}

/** Credentials kept in this tab's sessionStorage (or only in memory, with no storage). */
function keep(env: Env, credentials: Credentials): Credentials {
  try {
    env.storage?.setItem(TOKEN_KEY, credentials.token)
    env.storage?.setItem(SERVER_KEY, credentials.serverKey)
  } catch {
    // No storage: this tab works until it reloads.
  }
  return credentials
}

/** A refused code that typing again cannot fix: the session is taken, the code expired, or the tries ran out. */
const final = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.status === 410 || error.status === 429)

function refusal(error: unknown): HTMLElement {
  const taken = error instanceof ApiError && error.status === 409
  return el('div', { class: 'banner err', role: 'alert' },
    el('strong', {}, taken ? t('start.sessionTaken') : t('start.codeRefused')),
    el('p', {}, taken ? t('start.sessionTakenHelp') : t('start.again', { why: describe(error) })))
}

/**
 * No session yet: the code the terminal shows, typed here (`--pair`: nothing
 * secret went through the browser's command line). A launch code pasted from
 * the terminal works too. Resolves with the credentials, or undefined once no
 * code can work any more.
 */
function pair(env: Env, main: HTMLElement): Promise<Credentials | undefined> {
  return new Promise((resolve) => {
    const input = el('input', { id: 'pair-code', name: 'code', type: 'text', autocomplete: 'off', spellcheck: false, required: true, placeholder: 'ABCD-EFGH', aria: { describedby: 'pair-help' } })
    const status = el('span', { class: 'field-error', role: 'alert' })
    const submit = el('button', { type: 'submit', class: 'primary' }, t('pair.open'))
    const form = el('form', { class: 'card pair', aria: { label: t('pair.title') }, on: { submit: (event) => {
      event.preventDefault()
      const code = input.value.trim()
      if (!/^[A-Za-z0-9_\s-]{1,128}$/.test(code)) { replace(status, t('pair.typeCode')); return }
      submit.disabled = true
      void exchange(code, env.fetch).then((credentials) => resolve(keep(env, credentials)), (error: unknown) => {
        if (final(error)) { replace(main, refusal(error)); resolve(undefined); return }
        submit.disabled = false
        input.value = ''
        input.focus()
        replace(status, describe(error))
      })
    } } },
      el('div', { class: 'card-head' }, el('h3', {}, t('pair.title'))),
      el('div', { class: 'card-body' },
        el('div', { class: 'field' },
          el('label', { for: 'pair-code' }, t('pair.code')),
          input,
          el('span', { id: 'pair-help', class: 'field-help' }, t('pair.help')),
          status)),
      el('div', { class: 'card-foot' }, submit))
    replace(main, form)
    input.focus()
  })
}

if (typeof window !== 'undefined' && document.getElementById('app')) {
  void boot({ location: window.location, history: window.history, storage: storageOf(window), fetch: (input, init) => window.fetch(input, init), document, crypto: window.crypto, languages: window.navigator.languages ?? [window.navigator.language] })
}
