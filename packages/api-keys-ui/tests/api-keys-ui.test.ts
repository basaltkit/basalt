import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, apiKeyRoutes, apiKeysPlugin, authPlugin, authRoutes } from '@basaltkit/auth'
import { apiKeysPageHtml, apiKeysUiRoutes } from '../src/index.js'

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
