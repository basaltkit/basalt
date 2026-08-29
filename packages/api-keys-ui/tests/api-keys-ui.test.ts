import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, apiKeyRoutes, apiKeysPlugin, authPlugin, authRoutes } from '@basaltkit/auth'
import { apiKeysPageCsp, apiKeysPageHtml, apiKeysUiRoutes } from '../src/index.js'

describe('apiKeysPageHtml', () => {
  it('renders a self-contained page that calls the API-key routes', () => {
    const html = apiKeysPageHtml({ title: 'My Keys', apiBase: '/account' })
    expect(html).toContain('<title>My Keys</title>')
    expect(html).toContain("const API = \"/account\"")
    expect(html).toContain("fetch(API + '/apikeys'")
    expect(html).toContain("method: 'DELETE'") // revoke
    expect(html).toContain("won't be shown again") // one-time reveal
    expect(html).toContain('Create key')
  })
})

const secret = 'test-secret-value-123456'

async function boot() {
  const app = await createApp({
    plugins: [
      authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
      apiKeysPlugin(),
      fastifyPlugin({ routes: [...authRoutes(), ...apiKeyRoutes(), ...apiKeysUiRoutes()] }),
    ],
  }).boot()
  return { app, server: app.container.get(FASTIFY) }
}

describe('apiKeysUiRoutes', () => {
  it('serves the page and complements the JSON key routes', async () => {
    const { app, server } = await boot()

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'a@b.test', password: 'password123' } })
    const token = (await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@b.test', password: 'password123' } })).json().accessToken
    const auth = { authorization: `Bearer ${token}` }

    // the UI page
    const page = await server.inject({ method: 'GET', url: '/apikeys/ui', headers: auth })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('API keys')

    // the JSON routes the page drives
    const created = await server.inject({ method: 'POST', url: '/apikeys', headers: auth, payload: { name: 'CI', scopes: ['read'] } })
    expect(created.statusCode).toBe(201)
    expect((created.json().key as string).startsWith('mk_live_')).toBe(true)

    const list = await server.inject({ method: 'GET', url: '/apikeys', headers: auth })
    expect((list.json() as unknown[]).length).toBe(1)

    // unauthenticated cannot see the page
    expect((await server.inject({ method: 'GET', url: '/apikeys/ui' })).statusCode).toBe(401)

    await app.shutdown()
  })

  it('honours a custom path', () => {
    const routes = apiKeysUiRoutes({ path: '/settings/keys' })
    expect(routes[0]).toMatchObject({ method: 'GET', url: '/settings/keys' })
  })
})

describe('escaping + route-scoped CSP (S-5)', () => {
  it('escapes the title in text/attribute positions', () => {
    const html = apiKeysPageHtml({ title: '</title><script>alert(1)</script>' })
    expect(html).not.toContain('<script>alert(1)')
  })

  it('embedded JSON cannot terminate the inline script block', () => {
    const html = apiKeysPageHtml({ apiBase: '</script><svg onload=alert(1)>' })
    expect(html.match(/<\/script>/g)).toHaveLength(1) // only the genuine closer
  })

  it('the client-side esc helper also escapes quotes (no attribute breakout)', () => {
    expect(apiKeysPageHtml()).toContain(`[&<>"']`)
  })

  it('exports a CSP whose sha256 matches the inline script exactly', async () => {
    const { createHash } = await import('node:crypto')
    const html = apiKeysPageHtml({ apiBase: '/account' })
    const csp = apiKeysPageCsp({ apiBase: '/account' })
    // Plain index extraction (not a sanitizer) — avoids regex-on-HTML patterns.
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</scr' + 'ipt>'))
    // CSP script-hash source value (not a credential): sha256 per the CSP spec.
    const cspScriptDigest = createHash('sha256').update(script, 'utf8').digest('base64')
    expect(csp).toContain(`'sha256-${cspScriptDigest}'`)
    expect(csp).toContain("default-src 'none'")
  })

  it('serves the page with the route-scoped CSP header by default', async () => {
    const { app, server } = await boot()
    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'c@d.test', password: 'password123' } })
    const token = (await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'c@d.test', password: 'password123' } })).json().accessToken
    const page = await server.inject({ method: 'GET', url: '/apikeys/ui', headers: { authorization: `Bearer ${token}` } })
    expect(page.statusCode).toBe(200)
    expect(String(page.headers['content-security-policy'])).toContain('sha256-')
    await app.shutdown()
  })
})
