import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import {
  authPlugin,
  discoverOidcProvider,
  MemoryUserSource,
  oauthPlugin,
  oauthRoutes,
  stripTrailingSlashes,
  type OAuthProvider,
} from '../src/index.js'

const SECRET = 'x'.repeat(32)

const meta = {
  authorization_endpoint: 'https://idp/authorize',
  token_endpoint: 'https://idp/token',
  userinfo_endpoint: 'https://idp/userinfo',
}

/** A minimal provider whose authorizeUrl we can inspect in the 302 redirect. */
function testProvider(): OAuthProvider {
  return {
    name: 'test',
    authorizeUrl: 'https://provider.test/authorize',
    tokenUrl: 'https://provider.test/token',
    clientId: 'cid',
    clientSecret: 'csec',
    scopes: ['email'],
    async fetchProfile() {
      return { subject: 'p', email: 'e@x.com' }
    },
  }
}

describe('stripTrailingSlashes (linear, non-regex ReDoS fix)', () => {
  it('strips all trailing slashes and leaves the rest intact', () => {
    expect(stripTrailingSlashes('https://idp')).toBe('https://idp')
    expect(stripTrailingSlashes('https://idp/')).toBe('https://idp')
    expect(stripTrailingSlashes('https://idp/////')).toBe('https://idp')
    expect(stripTrailingSlashes('https://idp/path/')).toBe('https://idp/path')
    expect(stripTrailingSlashes('')).toBe('')
    expect(stripTrailingSlashes('/')).toBe('')
    expect(stripTrailingSlashes('////')).toBe('')
  })

  it('handles a long pathological run of trailing slashes promptly', () => {
    // The old `/\/+$/` regex is a polynomial-ReDoS target on long slash runs.
    // A linear trim must finish this in well under the timeout.
    const input = `https://idp${'/'.repeat(1_000_000)}`
    const start = performance.now()
    expect(stripTrailingSlashes(input)).toBe('https://idp')
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

describe('discoverOidcProvider trims the issuer (no double slash in discovery URL)', () => {
  it('strips trailing slashes from the issuer before appending .well-known', async () => {
    let seen = ''
    const doFetch = (async (url: string) => {
      seen = String(url)
      return { ok: true, status: 200, json: async () => meta }
    }) as unknown as typeof fetch
    await discoverOidcProvider({
      issuer: 'https://idp///',
      clientId: 'c',
      clientSecret: 's',
      fetch: doFetch,
    })
    expect(seen).toBe('https://idp/.well-known/openid-configuration')
    expect(seen).not.toContain('//.well-known')
  })

  it('finishes promptly for an issuer ending in a pathological slash run', async () => {
    let seen = ''
    const doFetch = (async (url: string) => {
      seen = String(url)
      return { ok: true, status: 200, json: async () => meta }
    }) as unknown as typeof fetch
    const start = performance.now()
    await discoverOidcProvider({
      issuer: `https://idp${'/'.repeat(1_000_000)}`,
      clientId: 'c',
      clientSecret: 's',
      fetch: doFetch,
    })
    expect(seen).toBe('https://idp/.well-known/openid-configuration')
    expect(performance.now() - start).toBeLessThan(1000)
  })
})

describe('oauthRoutes trims callbackBaseUrl (no double slash in redirect_uri)', () => {
  const boot = async (callbackBaseUrl: string) => {
    const app = await createApp({
      plugins: [
        authPlugin({ users: new MemoryUserSource(), secret: SECRET }),
        oauthPlugin({ providers: [testProvider()], secret: SECRET }),
        fastifyPlugin({ routes: oauthRoutes({ callbackBaseUrl }) }),
      ],
    }).boot()
    return { app, server: app.container.get(FASTIFY) }
  }

  it('builds a redirect_uri with a single slash even when callbackBaseUrl has trailing ones', async () => {
    const { app, server } = await boot('https://app.example.com///')
    const res = await server.inject({ method: 'GET', url: '/auth/oauth/test' })
    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location as string)
    const redirectUri = location.searchParams.get('redirect_uri')!
    expect(redirectUri).toBe('https://app.example.com/auth/oauth/test/callback')
    // The bug this guards against: a double slash between origin and path.
    expect(redirectUri).not.toMatch(/com\/\//)
    await app.shutdown()
  })
})
