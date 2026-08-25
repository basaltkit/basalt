import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  Auth,
  MemoryUserSource,
  OAuth,
  OAuthExchangeError,
  OAuthProviderUnknownError,
  OAuthStateInvalidError,
  discoverOidcProvider,
  githubProvider,
  googleProvider,
  oidcProvider,
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
function tokenFetch(text: string, ok = true, status = ok ? 200 : 400): typeof fetch {
  return (async () => ({ ok, status, text: async () => text })) as unknown as typeof fetch
}

/** Signs an arbitrary state body exactly like OAuth.signState, for crafting edge cases. */
function signRaw(payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

/** Signs a raw (possibly non-JSON) body string, so verifyState's JSON.parse can fail. */
function signRawBody(bodyPlain: string): string {
  const body = Buffer.from(bodyPlain).toString('base64url')
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

const stateOf = (oauth: OAuth, redirect = 'https://app/cb') =>
  new URL(oauth.authorizeUrl('test', redirect)).searchParams.get('state')!

describe('OAuth constructor defaults', () => {
  it('falls back to globalThis.fetch, Date.now, and the default state TTL', () => {
    // No fetch / now / stateTtlMs supplied — exercises every `?? default` branch.
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], { secret: SECRET })
    const url = new URL(oauth.authorizeUrl('test', 'https://app/cb'))
    expect(url.searchParams.get('state')).toContain('.')
  })

  it('names() reports the registered providers', () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], { secret: SECRET })
    expect(oauth.names()).toEqual(['test'])
  })
})

describe('OAuth provider lookup', () => {
  it('authorizeUrl throws for an unknown provider', () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], { secret: SECRET })
    expect(() => oauth.authorizeUrl('nope', 'https://app/cb')).toThrow(OAuthProviderUnknownError)
  })

  it('callback throws for a provider that verifies but is not registered', async () => {
    // A validly-signed state naming a provider the OAuth instance does not know.
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
    })
    const state = signRaw({ n: 'abc', e: NOW + 60_000, p: 'ghost' })
    await expect(oauth.callback('ghost', { code: 'c', state, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthProviderUnknownError,
    )
  })
})

describe('OAuth.verifyState edge cases', () => {
  const oauth = () =>
    new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch(JSON.stringify({ access_token: 'at' })),
    })

  it('rejects a state with no dot separator', async () => {
    await expect(oauth().callback('test', { code: 'c', state: 'no-dot-here', redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('rejects a same-length but forged signature (timingSafeEqual path)', async () => {
    const real = stateOf(oauth())
    const dot = real.indexOf('.')
    const body = real.slice(0, dot)
    const sig = real.slice(dot + 1)
    // Flip one char so the length matches the expected HMAC but the bytes differ.
    const forgedChar = sig[0] === 'A' ? 'B' : 'A'
    const forged = `${body}.${forgedChar}${sig.slice(1)}`
    await expect(oauth().callback('test', { code: 'c', state: forged, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('rejects a correctly-signed body that is not valid JSON', async () => {
    const state = signRawBody('this-is-not-json{')
    await expect(oauth().callback('test', { code: 'c', state, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('rejects a signed state whose expiry is not a number', async () => {
    const state = signRaw({ n: 'abc', e: 'soon', p: 'test' })
    await expect(oauth().callback('test', { code: 'c', state, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })

  it('rejects a state signed for a different provider name', async () => {
    const state = signRaw({ n: 'abc', e: NOW + 60_000, p: 'other' })
    await expect(oauth().callback('test', { code: 'c', state, redirectUri: 'x' })).rejects.toBeInstanceOf(
      OAuthStateInvalidError,
    )
  })
})

describe('OAuth.callback profile/exchange branches', () => {
  it('rejects a profile with no email', async () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: '' })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch(JSON.stringify({ access_token: 'at' })),
    })
    await expect(
      oauth.callback('test', { code: 'c', state: stateOf(oauth), redirectUri: 'https://app/cb' }),
    ).rejects.toBeInstanceOf(OAuthExchangeError)
  })

  it('surfaces an HTTP status when the token endpoint returns an empty body', async () => {
    // Empty text -> json = {}, no access_token -> falls back to `token endpoint HTTP <status>`.
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch('', true, 200),
    })
    await expect(
      oauth.callback('test', { code: 'c', state: stateOf(oauth), redirectUri: 'x' }),
    ).rejects.toThrow(/HTTP 200/)
  })

  it('prefers error_description in an exchange failure message', async () => {
    const oauth = new OAuth(makeAuth(), [testProvider({ subject: 'p', email: 'e@x.com' })], {
      secret: SECRET,
      now: () => NOW,
      fetch: tokenFetch(JSON.stringify({ error: 'invalid_grant', error_description: 'code expired' }), false),
    })
    await expect(
      oauth.callback('test', { code: 'c', state: stateOf(oauth), redirectUri: 'x' }),
    ).rejects.toThrow(/code expired/)
  })
})

describe('googleProvider branches', () => {
  it('honours custom scopes and maps an unverified profile without a name', async () => {
    const p = googleProvider({ clientId: 'c', clientSecret: 's', scopes: ['openid'] })
    expect(p.scopes).toEqual(['openid'])
    const doFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sub: 'g2', email: 'g2@x.com' }), // no email_verified, no name
    })) as unknown as typeof fetch
    expect(await p.fetchProfile('at', doFetch)).toEqual({
      subject: 'g2',
      email: 'g2@x.com',
      emailVerified: false,
    })
  })

  it('throws OAuthExchangeError when userinfo is not ok', async () => {
    const doFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
    await expect(googleProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).rejects.toBeInstanceOf(
      OAuthExchangeError,
    )
  })
})

describe('githubProvider branches', () => {
  it('throws when /user is not ok', async () => {
    const doFetch = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as unknown as typeof fetch
    await expect(githubProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).rejects.toBeInstanceOf(
      OAuthExchangeError,
    )
  })

  it('falls back to the /user email when /user/emails is not ok', async () => {
    const doFetch = (async (url: string) => {
      if (String(url).endsWith('/user')) {
        return { ok: true, status: 200, json: async () => ({ id: 7, login: 'ada', email: 'fallback@x.com' }) }
      }
      return { ok: false, status: 404, json: async () => [] }
    }) as unknown as typeof fetch
    expect(await githubProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).toEqual({
      subject: '7',
      email: 'fallback@x.com',
      emailVerified: false,
    })
  })

  it('uses the first verified (non-primary) email when no primary verified one exists', async () => {
    const doFetch = (async (url: string) => {
      if (String(url).endsWith('/user')) {
        return { ok: true, status: 200, json: async () => ({ id: 8, login: 'ada', name: 'Ada', email: null }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          { email: 'primary@x.com', primary: true, verified: false },
          { email: 'verified@x.com', primary: false, verified: true },
        ],
      }
    }) as unknown as typeof fetch
    expect(await githubProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).toEqual({
      subject: '8',
      email: 'verified@x.com',
      emailVerified: true,
      name: 'Ada',
    })
  })

  it('throws when no usable email can be resolved', async () => {
    const doFetch = (async (url: string) => {
      if (String(url).endsWith('/user')) {
        return { ok: true, status: 200, json: async () => ({ id: 9, login: 'ada', email: null }) }
      }
      return { ok: true, status: 200, json: async () => [{ email: 'x@x.com', primary: false, verified: false }] }
    }) as unknown as typeof fetch
    await expect(githubProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).rejects.toThrow(
      /no usable email/,
    )
  })
})

describe('oidcProvider branches', () => {
  it('defaults name to "oidc" and honours custom scopes', () => {
    const p = oidcProvider({
      authorizeUrl: 'https://idp/authorize',
      tokenUrl: 'https://idp/token',
      userInfoUrl: 'https://idp/userinfo',
      clientId: 'c',
      clientSecret: 's',
      scopes: ['openid'],
    })
    expect(p.name).toBe('oidc')
    expect(p.scopes).toEqual(['openid'])
  })

  it('throws when userinfo is not ok', async () => {
    const p = oidcProvider({
      authorizeUrl: 'https://idp/authorize',
      tokenUrl: 'https://idp/token',
      userInfoUrl: 'https://idp/userinfo',
      clientId: 'c',
      clientSecret: 's',
    })
    const doFetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    await expect(p.fetchProfile('at', doFetch)).rejects.toBeInstanceOf(OAuthExchangeError)
  })

  it('maps an unverified profile without a name', async () => {
    const p = oidcProvider({
      authorizeUrl: 'https://idp/authorize',
      tokenUrl: 'https://idp/token',
      userInfoUrl: 'https://idp/userinfo',
      clientId: 'c',
      clientSecret: 's',
    })
    const doFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ sub: 'o2', email: 'o2@corp.com' }), // no email_verified, no name
    })) as unknown as typeof fetch
    expect(await p.fetchProfile('at', doFetch)).toEqual({ subject: 'o2', email: 'o2@corp.com', emailVerified: false })
  })
})

describe('discoverOidcProvider branches', () => {
  const meta = {
    authorization_endpoint: 'https://idp/authorize',
    token_endpoint: 'https://idp/token',
    userinfo_endpoint: 'https://idp/userinfo',
  }

  it('works without a name (defaults) and without custom scopes', async () => {
    const doFetch = (async () => ({ ok: true, status: 200, json: async () => meta })) as unknown as typeof fetch
    const p = await discoverOidcProvider({
      issuer: 'https://idp',
      clientId: 'c',
      clientSecret: 's',
      fetch: doFetch,
    })
    expect(p.name).toBe('oidc')
    expect(p.scopes).toEqual(['openid', 'email', 'profile'])
  })

  it('forwards custom scopes to the built provider', async () => {
    const doFetch = (async () => ({ ok: true, status: 200, json: async () => meta })) as unknown as typeof fetch
    const p = await discoverOidcProvider({
      issuer: 'https://idp',
      clientId: 'c',
      clientSecret: 's',
      scopes: ['openid', 'groups'],
      fetch: doFetch,
    })
    expect(p.scopes).toEqual(['openid', 'groups'])
  })

  it('falls back to globalThis.fetch when no fetch is injected', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => meta })) as unknown as typeof fetch
    try {
      const p = await discoverOidcProvider({ issuer: 'https://idp', clientId: 'c', clientSecret: 's' })
      expect(p.authorizeUrl).toBe('https://idp/authorize')
    } finally {
      globalThis.fetch = original
    }
  })

  it('throws when the discovery document is not ok', async () => {
    const doFetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch
    await expect(
      discoverOidcProvider({ issuer: 'https://idp', clientId: 'c', clientSecret: 's', fetch: doFetch }),
    ).rejects.toThrow(/discovery HTTP 404/)
  })

  it('throws when the discovery document is missing endpoints', async () => {
    const doFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ authorization_endpoint: 'https://idp/authorize' }),
    })) as unknown as typeof fetch
    await expect(
      discoverOidcProvider({ issuer: 'https://idp', clientId: 'c', clientSecret: 's', fetch: doFetch }),
    ).rejects.toThrow(/missing required endpoints/)
  })
})
