import { Api, ApiError, exchange, ServerGone, type Fetch } from './api.js'
import { App, forgetSession, SERVER_KEY, TOKEN_KEY } from './app.js'
import { el, replace } from './dom.js'
import { describe } from './reply.js'

export interface Env {
  location: { hash: string; pathname: string }
  history: { replaceState: (data: unknown, unused: string, url?: string) => void }
  storage: Storage | undefined
  fetch: Fetch
  document: Document
  /** WebCrypto: the page checks its server before sending an answer. */
  crypto: Crypto | undefined
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
 * from the address bar at once), exchanged for the session token and the
 * server key, kept in this tab's sessionStorage — never persistent storage,
 * never a cookie. Then the server proves it is the process that printed the
 * URL, before anything else.
 */
export async function boot(env: Env): Promise<App | undefined> {
  const doc = env.document
  const shell = {
    nav: doc.getElementById('nav') as HTMLElement,
    bar: doc.getElementById('target-bar') as HTMLElement,
    main: doc.getElementById('app') as HTMLElement,
    session: doc.getElementById('session') as HTMLElement,
  }
  const match = /^#launch=([A-Za-z0-9_-]{1,128})$/.exec(env.location.hash)
  if (env.location.hash) env.history.replaceState(null, '', env.location.pathname)
  let token: string | undefined
  let serverKey: string | undefined
  try {
    token = env.storage?.getItem(TOKEN_KEY) ?? undefined
    serverKey = env.storage?.getItem(SERVER_KEY) ?? undefined
  } catch {
    token = undefined
  }
  if (match) {
    try {
      ;({ token, serverKey } = await exchange(match[1] as string, env.fetch))
      try {
        env.storage?.setItem(TOKEN_KEY, token)
        env.storage?.setItem(SERVER_KEY, serverKey)
      } catch {
        // No storage: this tab works until it reloads.
      }
    } catch (error) {
      const taken = error instanceof ApiError && error.status === 409
      replace(shell.main, el('div', { class: 'banner err', role: 'alert' },
        el('strong', {}, taken ? 'This UI already has its browser session.' : 'The launch code was refused.'),
        el('p', {}, taken
          ? 'Another tab or browser claimed it first. If that was not you, stop basalt-deploy-ui in your terminal now (Ctrl-C) and start it again.'
          : `${describe(error)}. Start basalt-deploy-ui again and open the URL it prints.`)))
      return undefined
    }
  }
  if (!token || !serverKey) {
    forgetSession(env.storage)
    replace(shell.main, el('p', {}, 'No session: open the URL basalt-deploy-ui printed in your terminal (it works once, for 2 minutes).'))
    return undefined
  }
  const app = new App(new Api(token, env.fetch, { serverKey, ...(env.crypto ? { crypto: env.crypto } : {}) }), shell, env.storage)
  try {
    await app.api.verifyServer()
    await app.start()
  } catch (error) {
    // The server is gone or not ours: the page already says so.
    if (error instanceof ServerGone) return undefined
    replace(shell.main, el('div', { class: 'banner err', role: 'alert' }, el('strong', {}, 'The UI could not start.'), el('p', {}, describe(error))))
    return undefined
  }
  return app
}

if (typeof window !== 'undefined' && document.getElementById('app')) {
  void boot({ location: window.location, history: window.history, storage: storageOf(window), fetch: (input, init) => window.fetch(input, init), document, crypto: window.crypto })
}
