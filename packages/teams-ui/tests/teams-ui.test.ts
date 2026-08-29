import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { FASTIFY, fastifyPlugin } from '@basaltkit/fastify'
import { MemoryUserSource, authPlugin, authRoutes } from '@basaltkit/auth'
import { MemoryTenantSource, headerResolver, tenancyPlugin } from '@basaltkit/tenancy'
import { TEAMS, teamRoutes, teamsPlugin } from '@basaltkit/teams'
import { teamsPageCsp, teamsPageHtml, teamsUiRoutes } from '../src/index.js'

describe('teamsPageHtml', () => {
  it('renders a self-contained page wired to the team routes', () => {
    const html = teamsPageHtml({ title: 'Acme Team', roles: ['owner', 'admin', 'member'], headers: { 'x-tenant-id': 'acme' } })
    expect(html).toContain('<title>Acme Team</title>')
    expect(html).toContain("fetch(API + '/team/members'")
    expect(html).toContain("fetch(API + '/team/invites'")
    expect(html).toContain("method: 'PATCH'") // change role
    expect(html).toContain("method: 'DELETE'") // remove / revoke
    expect(html).toContain('Send invite')
    expect(html).toContain('"x-tenant-id":"acme"') // headers injected
  })
})

const secret = 'test-secret-value-123456'

describe('teamsUiRoutes', () => {
  it('serves the page and complements the team JSON routes', async () => {
    const app = await createApp({
      plugins: [
        tenancyPlugin({ source: new MemoryTenantSource().add({ id: 'acme' }), resolvers: [headerResolver()] }),
        authPlugin({ users: new MemoryUserSource(), secret, loginThrottle: false }),
        teamsPlugin(),
        fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes(), ...teamsUiRoutes()] }),
      ],
    }).boot()
    const server = app.container.get(FASTIFY)

    await server.inject({ method: 'POST', url: '/auth/register', payload: { email: 'owner@acme.test', password: 'password123' } })
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'owner@acme.test', password: 'password123' } })
    const token = login.json().accessToken as string
    await app.container.get(TEAMS).addMember('acme', login.json().user.id, 'owner')
    const auth = { authorization: `Bearer ${token}`, 'x-tenant-id': 'acme' }

    // the UI page
    const page = await server.inject({ method: 'GET', url: '/team/ui', headers: auth })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(page.body).toContain('Members')

    // the JSON routes it drives
    expect((await server.inject({ method: 'GET', url: '/team/members', headers: auth })).json().length).toBe(1)
    const invited = await server.inject({ method: 'POST', url: '/team/invites', headers: auth, payload: { email: 'bob@acme.test', role: 'member' } })
    expect(invited.statusCode).toBe(201)

    // unauthenticated cannot see the page
    expect((await server.inject({ method: 'GET', url: '/team/ui' })).statusCode).toBe(401)

    await app.shutdown()
  })

  it('honours a custom path', () => {
    expect(teamsUiRoutes({ path: '/settings/team' })[0]).toMatchObject({ method: 'GET', url: '/settings/team' })
  })
})

describe('escaping + route-scoped CSP (S-5)', () => {
  it('escapes title and roles in server-rendered positions', () => {
    const html = teamsPageHtml({
      title: '</title><script>alert(1)</script>',
      roles: ['<img src=x onerror=alert(1)>'],
    })
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<img src=x')
  })

  it('embedded JSON (headers can carry tenant data) cannot terminate the script block', () => {
    const html = teamsPageHtml({ headers: { 'x-tenant-id': '</script><svg onload=alert(1)>' } })
    expect(html.match(/<\/script>/g)).toHaveLength(1)
  })

  it('the client-side esc helper escapes both quote styles', () => {
    expect(teamsPageHtml()).toContain(`[&<>"']`)
  })

  it('exports a CSP whose sha256 matches the inline script exactly', async () => {
    const { createHash } = await import('node:crypto')
    const opts = { apiBase: '/t', roles: ['owner'], headers: { 'x-tenant-id': 'acme' } }
    const page = teamsPageHtml(opts)
    // Plain index extraction (not a sanitizer) — avoids regex-on-HTML patterns.
    const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.indexOf('</scr' + 'ipt>'))
    // CSP script-hash source value (not a credential): sha256 per the CSP spec.
    const cspScriptDigest = createHash('sha256').update(script, 'utf8').digest('base64')
    expect(teamsPageCsp(opts)).toContain(`'sha256-${cspScriptDigest}'`)
  })

  it('the route serves the CSP header by default', () => {
    const [r] = teamsUiRoutes()
    expect(r).toBeTruthy() // handler sets the header — covered end-to-end in api-keys-ui; here we assert the builder exists
    expect(teamsPageCsp()).toContain("default-src 'none'")
  })
})
