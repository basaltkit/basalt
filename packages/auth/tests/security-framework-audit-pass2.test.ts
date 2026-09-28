import { randomBytes, scryptSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { definePlugin } from '@basaltkit/core'
import { route } from '@basaltkit/http'
import {
  API_KEYS,
  Auth,
  MemoryPasskeyStore,
  MemoryUserSource,
  MemoryWebAuthnChallengeStore,
  OAuth,
  OAuthExchangeError,
  OAuthProviderConfigError,
  PasskeyNotFoundError,
  ScryptPasswordHasher,
  WebAuthnService,
  WebAuthnSubjectMismatchError,
  WebAuthnVerificationError,
  apiKeysPlugin,
  discoverOidcProvider,
  githubProvider,
  googleProvider,
  oauthRoutes,
  oidcProvider,
  type OAuthProvider,
  type WebAuthnVerifier,
} from '../src/index.js'
import { availableAdapters, boot, type Harness } from './helpers/adapters.js'

/** Framework audit, pass 2 (FA-051, FA-056, FA-058, FA-059, FA-H22, hashing ceiling). */

const SECRET = 'x'.repeat(32)
const REDIRECT = 'https://app/cb'

// --- WebAuthn -----------------------------------------------------------------

function passkeys(verdict: { verified: boolean; newCounter: number } = { verified: true, newCounter: 1 }) {
  const credentials = new MemoryPasskeyStore()
  const verifier: WebAuthnVerifier = {
    async verifyRegistration() {
      return { verified: false }
    },
    async verifyAuthentication() {
      return verdict
    },
  }
  const service = new WebAuthnService({
    config: { rpId: 'x.test', rpName: 'x', origin: 'https://x.test' },
    credentials,
    challenges: new MemoryWebAuthnChallengeStore(),
    verifier,
  })
  return { service, credentials }
}

describe('FA-051 · WebAuthnService.remove checks the owner', () => {
  it("refuses to remove another user's passkey by id", async () => {
    const { service, credentials } = passkeys()
    await credentials.add({ id: 'cred-bob', userId: 'bob', publicKey: 'pk', counter: 0, createdAt: 0 })
    await expect(service.remove('alice', 'cred-bob')).rejects.toBeInstanceOf(PasskeyNotFoundError)
    expect(await service.list('bob')).toHaveLength(1)
  })

  it('an unknown id and a foreign id fail the same way; the owner can remove their own', async () => {
    const { service, credentials } = passkeys()
    await credentials.add({ id: 'cred-bob', userId: 'bob', publicKey: 'pk', counter: 0, createdAt: 0 })
    await expect(service.remove('bob', 'nope')).rejects.toBeInstanceOf(PasskeyNotFoundError)
    await service.remove('bob', 'cred-bob')
    expect(await service.list('bob')).toEqual([])
  })
})

describe('FA-059 · WebAuthn authentication hardening', () => {
  it('a challenge started for a user is not satisfied by another user\'s passkey (step-up)', async () => {
    const { service, credentials } = passkeys()
    await credentials.add({ id: 'cred-bob', userId: 'bob', publicKey: 'pk', counter: 0, createdAt: 0 })
    await service.startAuthentication('sess', 'alice')
    await expect(service.finishAuthentication('sess', { id: 'cred-bob' })).rejects.toBeInstanceOf(
      WebAuthnSubjectMismatchError,
    )
  })

  it('discoverable login (no userId) still accepts any registered passkey', async () => {
    const { service, credentials } = passkeys()
    await credentials.add({ id: 'cred-bob', userId: 'bob', publicKey: 'pk', counter: 0, createdAt: 0 })
    await service.startAuthentication('sess')
    expect(await service.finishAuthentication('sess', { id: 'cred-bob' })).toEqual({ userId: 'bob', credentialId: 'cred-bob' })
  })

  it('a non-integer counter from the verifier is refused and never stored (it would disable clone detection)', async () => {
    const { service, credentials } = passkeys({ verified: true, newCounter: Number.NaN })
    await credentials.add({ id: 'c', userId: 'u', publicKey: 'pk', counter: 5, createdAt: 0 })
    await service.startAuthentication('sess')
    await expect(service.finishAuthentication('sess', { id: 'c' })).rejects.toBeInstanceOf(WebAuthnVerificationError)
    expect((await credentials.get('c'))?.counter).toBe(5)
  })
})

// --- OAuth / OIDC ---------------------------------------------------------------

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`

function fakeProvider(
  profile: { subject: string; email: string; emailVerified?: boolean },
  extra: Partial<OAuthProvider> = {},
): OAuthProvider {
  return {
    name: 'test',
    authorizeUrl: 'https://idp.test/authorize',
    tokenUrl: 'https://idp.test/token',
    clientId: 'cid',
    clientSecret: 'csec',
    scopes: ['email'],
    async fetchProfile() {
      return profile
    },
    ...extra,
  }
}

const tokenFetch = (payload: unknown, contentText?: string): typeof fetch =>
  (async () => ({ ok: true, status: 200, text: async () => contentText ?? JSON.stringify(payload) })) as unknown as typeof fetch

async function login(oauth: OAuth, name = 'test') {
  const { url, binding } = oauth.authorize(name, REDIRECT)
  const params = new URL(url).searchParams
  const run = () => oauth.callback(name, { code: 'c', state: params.get('state')!, redirectUri: REDIRECT, binding })
  return { run, nonce: params.get('nonce') }
}

describe('FA-056 · an OIDC provider is restricted to its email domains', () => {
  it("a customer's IdP asserting another domain (verified) does not log into the victim's account", async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const victim = await auth.socialLogin('victim@other.com', { emailVerified: true })
    const evil = fakeProvider(
      { subject: 's', email: 'victim@other.com', emailVerified: true },
      { name: 'acme-idp', enterprise: true, allowedEmailDomains: ['acme.com'] },
    )
    const oauth = new OAuth(auth, [evil], { secret: SECRET, fetch: tokenFetch({ access_token: 'at' }) })
    const { run } = await login(oauth, 'acme-idp')
    await expect(run()).rejects.toThrow(/not trusted for the email domain/)
    expect(victim.user.email).toBe('victim@other.com')
  })

  it('an allowed domain logs in (case-insensitively)', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const p = fakeProvider({ subject: 's', email: 'Ana@ACME.com', emailVerified: true }, { allowedEmailDomains: ['acme.com'] })
    const oauth = new OAuth(auth, [p], { secret: SECRET, fetch: tokenFetch({ access_token: 'at' }) })
    const { run } = await login(oauth)
    expect((await run()).user.email).toBe('ana@acme.com')
  })

  it('refuses to start with several providers when an enterprise IdP has no allowlist', () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const okta = oidcProvider({ name: 'okta', authorizeUrl: 'https://a', tokenUrl: 'https://t', userInfoUrl: 'https://u', clientId: 'c', clientSecret: 's' })
    const google = googleProvider({ clientId: 'c', clientSecret: 's' })
    expect(() => new OAuth(auth, [google, okta], { secret: SECRET })).toThrow(OAuthProviderConfigError)
    // Restricted, or an explicit opt-out, boots.
    const restricted = oidcProvider({ name: 'okta', authorizeUrl: 'https://a', tokenUrl: 'https://t', userInfoUrl: 'https://u', clientId: 'c', clientSecret: 's', allowedEmailDomains: ['acme.com'] })
    expect(() => new OAuth(auth, [google, restricted], { secret: SECRET })).not.toThrow()
    const optOut = oidcProvider({ name: 'okta', authorizeUrl: 'https://a', tokenUrl: 'https://t', userInfoUrl: 'https://u', clientId: 'c', clientSecret: 's', allowAnyEmailDomain: true })
    expect(() => new OAuth(auth, [google, optOut], { secret: SECRET })).not.toThrow()
    // A single IdP is the app's own: no allowlist required.
    expect(() => new OAuth(auth, [okta], { secret: SECRET })).not.toThrow()
  })

  it('rejects malformed allowlists and duplicate provider names at boot', () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const p = (extra: Partial<OAuthProvider>) => fakeProvider({ subject: 's', email: 'a@b.c' }, extra)
    expect(() => new OAuth(auth, [p({ allowedEmailDomains: [] })], { secret: SECRET })).toThrow(OAuthProviderConfigError)
    expect(() => new OAuth(auth, [p({ allowedEmailDomains: ['*.acme.com'] })], { secret: SECRET })).toThrow(OAuthProviderConfigError)
    expect(() => new OAuth(auth, [p({}), p({})], { secret: SECRET })).toThrow(OAuthProviderConfigError)
  })

  it('discoverOidcProvider forwards the allowlist and the issuer', async () => {
    const meta = { issuer: 'https://idp', authorization_endpoint: 'https://idp/a', token_endpoint: 'https://idp/t', userinfo_endpoint: 'https://idp/u' }
    const doFetch = (async () => ({ ok: true, status: 200, json: async () => meta })) as unknown as typeof fetch
    const p = await discoverOidcProvider({ issuer: 'https://idp', clientId: 'c', clientSecret: 's', allowedEmailDomains: ['acme.com'], fetch: doFetch })
    expect(p.allowedEmailDomains).toEqual(['acme.com'])
    expect(p.issuer).toBe('https://idp')
    expect(p.enterprise).toBe(true)
  })
})

describe('FA-058 · OAuth provider replies are validated', () => {
  it('a userinfo without email/sub fails instead of logging into the account "undefined"', async () => {
    const res = { ok: true, status: 200, json: async () => ({ sub: 'x' }) }
    const doFetch = (async () => res) as unknown as typeof fetch
    const oidc = oidcProvider({ authorizeUrl: 'https://a', tokenUrl: 'https://t', userInfoUrl: 'https://u', clientId: 'c', clientSecret: 's' })
    await expect(oidc.fetchProfile('at', doFetch)).rejects.toBeInstanceOf(OAuthExchangeError)
    await expect(googleProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', doFetch)).rejects.toBeInstanceOf(OAuthExchangeError)
    const noSub = (async () => ({ ok: true, status: 200, json: async () => ({ email: 'a@b.c' }) })) as unknown as typeof fetch
    await expect(oidc.fetchProfile('at', noSub)).rejects.toBeInstanceOf(OAuthExchangeError)
    const noId = (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch
    await expect(githubProvider({ clientId: 'c', clientSecret: 's' }).fetchProfile('at', noId)).rejects.toBeInstanceOf(OAuthExchangeError)
  })

  it('an email that is not a single-@ address is refused before any account is created', async () => {
    const users = new MemoryUserSource()
    const auth = new Auth({ users, secret: SECRET })
    const oauth = new OAuth(auth, [fakeProvider({ subject: 's', email: 'undefined', emailVerified: true })], {
      secret: SECRET,
      fetch: tokenFetch({ access_token: 'at' }),
    })
    const { run } = await login(oauth)
    await expect(run()).rejects.toBeInstanceOf(OAuthExchangeError)
    expect(await users.findByEmail('undefined')).toBeNull()
  })

  it('an HTML token-endpoint reply is an exchange error (not a 500 SyntaxError)', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const oauth = new OAuth(auth, [fakeProvider({ subject: 's', email: 'a@b.c' })], {
      secret: SECRET,
      fetch: tokenFetch(null, '<html>502 Bad Gateway</html>'),
    })
    const { run } = await login(oauth)
    await expect(run()).rejects.toBeInstanceOf(OAuthExchangeError)
  })

  it('a provider that never answers times out as an exchange error', async () => {
    const hanging = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })) as unknown as typeof fetch
    const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
    const oauth = new OAuth(auth, [fakeProvider({ subject: 's', email: 'a@b.c' })], { secret: SECRET, fetch: hanging, timeoutMs: 50 })
    const { run } = await login(oauth)
    await expect(run()).rejects.toBeInstanceOf(OAuthExchangeError)
  })

  describe('id_token claims (openid flows)', () => {
    const oidc = (extra: Partial<OAuthProvider> = {}) =>
      fakeProvider({ subject: 's', email: 'a@acme.com', emailVerified: true }, { scopes: ['openid', 'email'], ...extra })
    const future = () => Math.floor(Date.now() / 1000) + 300
    async function attempt(provider: OAuthProvider, claims: (nonce: string) => Record<string, unknown> | undefined) {
      const auth = new Auth({ users: new MemoryUserSource(), secret: SECRET })
      let reply: Record<string, unknown> = { access_token: 'at' }
      const doFetch = (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(reply) })) as unknown as typeof fetch
      const oauth = new OAuth(auth, [provider], { secret: SECRET, fetch: doFetch })
      const { run, nonce } = await login(oauth)
      const c = claims(nonce!)
      if (c) reply = { access_token: 'at', id_token: idToken(c) }
      return run()
    }

    it('accepts a matching nonce, audience, expiry and issuer', async () => {
      const r = await attempt(oidc({ issuer: 'https://idp.test' }), (nonce) => ({ nonce, aud: 'cid', exp: future(), iss: 'https://idp.test' }))
      expect(r.user.email).toBe('a@acme.com')
    })

    it('refuses an openid flow whose token response has no id_token', async () => {
      await expect(attempt(oidc(), () => undefined)).rejects.toThrow(/no id_token/)
    })

    it('refuses an id_token for another client', async () => {
      await expect(attempt(oidc(), (nonce) => ({ nonce, aud: 'other', exp: future() }))).rejects.toThrow(/audience/)
    })

    it('refuses an expired id_token', async () => {
      await expect(attempt(oidc(), (nonce) => ({ nonce, aud: ['cid'], exp: 1 }))).rejects.toThrow(/expired/)
    })

    it('refuses an id_token from another issuer', async () => {
      await expect(
        attempt(oidc({ issuer: 'https://idp.test' }), (nonce) => ({ nonce, aud: 'cid', exp: future(), iss: 'https://evil.test' })),
      ).rejects.toThrow(/issuer/)
    })
  })

  describe('discovery', () => {
    const discover = (meta: Record<string, unknown>) =>
      discoverOidcProvider({
        issuer: 'https://idp',
        clientId: 'c',
        clientSecret: 's',
        fetch: (async () => ({ ok: true, status: 200, json: async () => meta })) as unknown as typeof fetch,
      })
    const endpoints = { authorization_endpoint: 'https://idp/a', token_endpoint: 'https://idp/t', userinfo_endpoint: 'https://idp/u' }

    it('refuses a document published for another issuer (or none)', async () => {
      await expect(discover({ ...endpoints, issuer: 'https://evil' })).rejects.toThrow(/another issuer/)
      await expect(discover(endpoints)).rejects.toThrow(/another issuer/)
    })

    it('refuses plain-http endpoints except on loopback', async () => {
      await expect(discover({ ...endpoints, issuer: 'https://idp', token_endpoint: 'http://idp/t' })).rejects.toThrow(/non-https/)
      const local = await discover({ ...endpoints, issuer: 'https://idp', token_endpoint: 'http://localhost:8080/t' })
      expect(local.tokenUrl).toBe('http://localhost:8080/t')
    })
  })

  it('oauthRoutes are rate-limited by default (each callback costs two provider round-trips)', () => {
    const routes = oauthRoutes({ callbackBaseUrl: 'https://app' })
    for (const r of routes) expect((r.meta as { rateLimit?: unknown }).rateLimit).toEqual({ limit: 10, windowMs: 60_000 })
    for (const r of oauthRoutes({ callbackBaseUrl: 'https://app', rateLimit: false })) {
      expect((r.meta as { rateLimit?: unknown }).rateLimit).toBeUndefined()
    }
  })
})

// --- API keys -------------------------------------------------------------------

describe.each(availableAdapters)('FA-H22 · two different API keys on one request are ambiguous (%s)', (adapter) => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })
  const routes = [route({ method: 'GET', url: '/secret', meta: { scopes: ['reports:read'] }, handler: () => ({ ok: true }) })]

  it('a forged Bearer mk_ next to a valid x-api-key is refused as ambiguous, not silently preferred', async () => {
    let issue!: () => Promise<{ key: string }>
    const plugin = apiKeysPlugin()
    const grab = definePlugin({
      name: 'test:grab',
      register({ container }) {
        issue = () => container.get(API_KEYS).issue({ name: 'k', scopes: ['reports:read'] })
      },
    })
    h = await boot(adapter, [plugin, grab], routes)
    const { key } = await issue()
    expect((await h.call({ method: 'GET', url: '/secret', headers: { 'x-api-key': key } })).status).toBe(200)
    const both = await h.call({ method: 'GET', url: '/secret', headers: { 'x-api-key': key, authorization: 'Bearer mk_live_forged' } })
    expect(both.status).toBe(400)
    expect(both.body.error.code).toBe('AUTH_APIKEY_AMBIGUOUS')
    // The same key in both carriers is not ambiguous.
    const same = await h.call({ method: 'GET', url: '/secret', headers: { 'x-api-key': key, authorization: `Bearer ${key}` } })
    expect(same.status).toBe(200)
  })
})

// --- Hashing --------------------------------------------------------------------

describe('Melhoria 2 · the scrypt cost read from a stored hash is capped', () => {
  const encode = (N: number, r: number, p: number, password: string) => {
    const salt = randomBytes(16)
    const derived = scryptSync(password, salt, 32, { N, r, p, maxmem: 512 * 1024 * 1024 })
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`
  }

  it('a hash declaring a parallelism above the ceiling never verifies (even when it is correct)', async () => {
    const hasher = new ScryptPasswordHasher()
    expect(await hasher.verify('pw', encode(1024, 1, 64, 'pw'))).toBe(false)
    expect(await hasher.verify('pw', encode(1024, 1, 1, 'pw'))).toBe(true)
  })

  it('malformed or out-of-range parameters return false instead of throwing', async () => {
    const hasher = new ScryptPasswordHasher()
    const good = encode(1024, 1, 1, 'pw').split('$')
    const withParams = (n: string, r: string, p: string) => ['scrypt', n, r, p, good[4], good[5]].join('$')
    expect(await hasher.verify('pw', withParams('1000', '1', '1'))).toBe(false) // N not a power of two
    expect(await hasher.verify('pw', withParams(String(2 ** 21), '1', '1'))).toBe(false)
    expect(await hasher.verify('pw', withParams('1024', '1e3', '1'))).toBe(false)
    expect(await hasher.verify('pw', withParams('1024', '-1', '1'))).toBe(false)
  })

  it('refuses to be configured beyond the ceilings', () => {
    expect(() => new ScryptPasswordHasher({ N: 2 ** 21, r: 8, p: 1 })).toThrow(RangeError)
    expect(() => new ScryptPasswordHasher({ N: 65536, r: 8, p: 64 })).toThrow(RangeError)
  })
})
