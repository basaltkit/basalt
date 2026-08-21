import { describe, expect, it } from 'vitest'
import {
  Auth,
  githubProvider,
  googleProvider,
  MemoryUserSource,
  OAuth,
  OAuthExchangeError,
  OAuthStateInvalidError,
  oidcProvider,
  discoverOidcProvider,
  type OAuthProvider,
} from '../src/index.js'

const SECRET = 'x'.repeat(32)
const NOW = 1_700_000_000_000

const makeAuth = () => new Auth({ users: new MemoryUserSource(), secret: SECRET })

function testProvider(profile: { subject: string; email: string; emailVerified?: boolean }): OAuthProvider {
  return {
    name: 'test',
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    clientId: 'cid',
    clientSecret: 'csec',
    scopes: ['email'],
    async fetchProfile() {
      return profile
    },
  }
}

/** A fetch double for the token endpoint (exchangeCode reads `.text()`). */
function tokenFetch(payload: Record<string, unknown> = { access_token: 'at' }, ok = true): typeof fetch {
  return (async () => ({
    ok,
    status: ok ? 200 : 400,
    text: async () => JSON.stringify(payload),
  })) as unknown as typeof fetch
}

const stateOf = (oauth: OAuth, redirect = 'https://app/cb') =>
  new URL(oauth.authorizeUrl('test', redirect)).searchParams.get('state')!

describe('Auth.socialLogin', () => {
  it('creates a passwordless account for a new email and issues usable tokens', async () => {
    const auth = makeAuth()
    const r = await auth.socialLogin('new@x.com', { emailVerified: true })
    expect(r.created).toBe(true)
    expect((await auth.verifyAccessToken(r.tokens.accessToken)).sub).toBeTruthy()
    // The account is passwordless — password login must not work.
    await expect(auth.login('new@x.com', 'whatever-password')).rejects.toBeTruthy()
  })

  it('logs into an existing account without creating a duplicate', async () => {
    const auth = makeAuth()
    const u = await auth.register('a@x.com', 'password123')
    const r = await auth.socialLogin('a@x.com')
    expect(r.created).toBe(false)
    expect(r.user.id).toBe(u.id)
  })
})

describe('OAuth authorization-code flow', () => {
  it('builds an authorize URL with client_id, redirect_uri, scope and a signed state', () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
    })
    const url = new URL(oauth.authorizeUrl('test', 'https://app/cb'))
    expect(url.origin + url.pathname).toBe('https://provider.test/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb')
    expect(url.searchParams.get('scope')).toBe('email')
    expect(url.searchParams.get('state')).toContain('.')
  })

  it('verifies state, exchanges the code and logs the user in', async () => {
    const auth = makeAuth()
    const oauth = new OAuth(auth, [testProvider({ subject: 'p1', email: 'oauth@x.com', emailVerified: true })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch(),
    })
    const r = await oauth.callback('test', { code: 'code', state: stateOf(oauth), redirectUri: 'https://app/cb' })
    expect(r.created).toBe(true)
    expect((await auth.verifyAccessToken(r.tokens.accessToken)).sub).toBeTruthy()
  })

  it('rejects a missing, tampered, or foreign-provider state', async () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch(),
    })
    await expect(oauth.callback('test', { code: 'c', state: undefined, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
    await expect(oauth.callback('test', { code: 'c', state: 'abc.def', redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('rejects an expired state', async () => {
    const state = stateOf(
      new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], { secret: SECRET, now: () => NOW }),
    )
    // Same secret, but the clock is now past the 10-minute state TTL.
    const later = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW + 20 * 60_000,
      fetch: tokenFetch(),
    })
    await expect(later.callback('test', { code: 'c', state, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('surfaces a token-exchange failure', async () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch({ error: 'invalid_grant' }, false),
    })
    await expect(
      oauth.callback('test', { code: 'c', state: stateOf(oauth), redirectUri: 'x' }),
    ).rejects.toBeInstanceOf(OAuthExchangeError)
  })
})

describe('prebuilt provider profile mapping', () => {
  it('googleProvider maps sub/email/email_verified/name', async () => {
    const doFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sub: 'g1', email: 'g@x.com', email_verified: true, name: 'Ada' }),
    })) as unknown as typeof fetch
    expect(await googleProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).toEqual({
      subject: 'g1',
      email: 'g@x.com',
      emailVerified: true,
      name: 'Ada',
    })
  })

  it('githubProvider reads the primary verified email from /user/emails', async () => {
    const doFetch = (async (url: string) => {
      if (String(url).endsWith('/user')) {
        return { ok: true, status: 200, json: async () => ({ id: 99, login: 'ada', name: 'Ada', email: null }) }
      }
      return { ok: true, status: 200, json: async () => [{ email: 'ada@x.com', primary: true, verified: true }] }
    }) as unknown as typeof fetch
    expect(await githubProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).toMatchObject({
      subject: '99',
      email: 'ada@x.com',
      emailVerified: true,
      name: 'Ada',
    })
  })
})

describe('OIDC provider (enterprise SSO)', () => {
  it('oidcProvider maps the standard userinfo claims', async () => {
    const doFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sub: 'o1', email: 'e@corp.com', email_verified: true, name: 'Bob' }),
    })) as unknown as typeof fetch
    const p = oidcProvider({
      authorizeUrl: 'https://idp/authorize',
      tokenUrl: 'https://idp/token',
      userInfoUrl: 'https://idp/userinfo',
      clientId: 'c',
      clientSecret: 's',
    })
    expect(p.scopes).toEqual(['openid', 'email', 'profile'])
    expect(await p.fetchProfile('at', doFetch)).toEqual({
      subject: 'o1',
      email: 'e@corp.com',
      emailVerified: true,
      name: 'Bob',
    })
  })

  it('discoverOidcProvider resolves endpoints from the well-known document', async () => {
    const doFetch = (async (url: string) => {
      expect(String(url)).toBe('https://acme.okta.com/.well-known/openid-configuration')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authorization_endpoint: 'https://acme.okta.com/authorize',
          token_endpoint: 'https://acme.okta.com/token',
          userinfo_endpoint: 'https://acme.okta.com/userinfo',
        }),
      }
    }) as unknown as typeof fetch
    const p = await discoverOidcProvider({
      name: 'okta',
      issuer: 'https://acme.okta.com/',
      clientId: 'c',
      clientSecret: 's',
      fetch: doFetch,
    })
    expect(p.name).toBe('okta')
    expect(p.authorizeUrl).toBe('https://acme.okta.com/authorize')
    expect(p.tokenUrl).toBe('https://acme.okta.com/token')
  })
})
