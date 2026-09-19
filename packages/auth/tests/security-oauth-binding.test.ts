import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Auth,
  MemoryUserSource,
  OAuth,
  OAuthStateInvalidError,
  authPlugin,
  oauthPlugin,
  oauthRoutes,
  type OAuthProvider,
} from '../src/index.js'
import { availableAdapters, boot, fastHasher, type Harness } from './helpers/adapters.js'

/**
 * OAuth login CSRF / code injection (F17): the `state` must be bound to the
 * browser that started the flow and be single-use, and the code exchange must
 * be bound to that same flow with PKCE (plus an OIDC nonce).
 */

const secret = 'x'.repeat(32)

interface Exchange {
  body: URLSearchParams
}

function provider(name = 'test', scopes = ['email']): { p: OAuthProvider; exchanges: Exchange[]; fetch: typeof fetch } {
  const exchanges: Exchange[] = []
  const p: OAuthProvider = {
    name,
    authorizeUrl: 'https://idp.test/authorize',
    tokenUrl: 'https://idp.test/token',
    clientId: 'cid',
    clientSecret: 'csec',
    scopes,
    async fetchProfile() {
      return { subject: 's1', email: 'user@idp.test', emailVerified: true }
    },
  }
  const doFetch = (async (_url: string, init: { body: string }) => {
    exchanges.push({ body: new URLSearchParams(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'at' }) }
  }) as unknown as typeof fetch
  return { p, exchanges, fetch: doFetch }
}

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

describe('OAuth service: state is browser-bound, single-use, and PKCE-protected', () => {
  it('the authorize URL carries an S256 PKCE challenge, and OIDC flows a nonce', () => {
    const { p, fetch } = provider('oidc', ['openid', 'email'])
    const oauth = new OAuth(new Auth({ users: new MemoryUserSource(), secret }), [p], { secret, fetch })
    const { url, binding } = oauth.authorize('oidc', 'https://app/cb')
    const params = new URL(url).searchParams
    expect(binding.length).toBeGreaterThanOrEqual(32)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(params.get('nonce')).toBeTruthy()
  })

  it('a callback without the initiating browser binding is refused (login CSRF)', async () => {
    const { p, fetch } = provider()
    const oauth = new OAuth(new Auth({ users: new MemoryUserSource(), secret }), [p], { secret, fetch })
    const { url } = oauth.authorize('test', 'https://app/cb')
    const state = new URL(url).searchParams.get('state')!
    await expect(oauth.callback('test', { code: 'c', state, redirectUri: 'https://app/cb', binding: undefined })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
    const other = oauth.authorize('test', 'https://app/cb').binding
    await expect(oauth.callback('test', { code: 'c', state, redirectUri: 'https://app/cb', binding: other })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('a state is single-use and the code exchange sends the PKCE verifier', async () => {
    const { p, fetch, exchanges } = provider()
    const oauth = new OAuth(new Auth({ users: new MemoryUserSource(), secret }), [p], { secret, fetch })
    const { url, binding } = oauth.authorize('test', 'https://app/cb')
    const params = new URL(url).searchParams
    const state = params.get('state')!

    await oauth.callback('test', { code: 'c', state, redirectUri: 'https://app/cb', binding })
    const verifier = exchanges[0]!.body.get('code_verifier')
    expect(verifier).toBeTruthy()
    expect(s256(verifier!)).toBe(params.get('code_challenge'))

    await expect(oauth.callback('test', { code: 'c', state, redirectUri: 'https://app/cb', binding })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })
})

let harness: Harness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

describe.each(availableAdapters)('OAuth routes bind the flow to the browser (%s)', (adapter) => {
  it('sets an HttpOnly binding cookie, requires it at the callback, and clears it', async () => {
    const { p, fetch } = provider()
    harness = await boot(
      adapter,
      [authPlugin({ users: new MemoryUserSource(), secret, hasher: fastHasher }), oauthPlugin({ providers: [p], secret, fetch })],
      oauthRoutes({ callbackBaseUrl: 'https://app.test' }),
    )
    const start = await harness.call({ method: 'GET', url: '/auth/oauth/test' })
    expect(start.status).toBe(302)
    const location = String(start.headers['location'])
    const state = new URL(location).searchParams.get('state')!
    const rawCookie = String([start.headers['set-cookie']].flat()[0])
    expect(rawCookie).toMatch(/HttpOnly/i)
    expect(rawCookie).toMatch(/SameSite=Lax/i)
    const cookie = rawCookie.split(';')[0]!

    const q = `/auth/oauth/test/callback?code=abc&state=${encodeURIComponent(state)}`
    // The attacker's callback URL opened in the victim's browser: no binding cookie.
    const forged = await harness.call({ method: 'GET', url: q })
    expect(forged.status).toBe(400)
    expect(forged.body.error.code).toBe('AUTH_OAUTH_STATE_INVALID')

    const ok = await harness.call({ method: 'GET', url: q, headers: { cookie } })
    expect(ok.status).toBe(200)
    expect(String([ok.headers['set-cookie']].flat()[0])).toMatch(/Max-Age=0/)

    // Replay of the same state and cookie.
    const replay = await harness.call({ method: 'GET', url: q, headers: { cookie } })
    expect(replay.status).toBe(400)
  })
})
