import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@basaltkit/fastify'
import { buildApp } from '../src/app.js'
import { AUDIT } from '../src/domain.js'

async function boot() {
  const app = await buildApp({ logLevel: 'silent' }).boot()
  return { app, server: app.container.get(FASTIFY), audit: app.container.get(AUDIT) }
}

describe('playground E2E — Phase 1 integrated', () => {
  it('full flow: create, list, fetch, delete — with audit via events', async () => {
    const { app, server, audit } = await boot()

    const created = await server.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Basalt' },
    })
    expect(created.statusCode).toBe(201)
    const project = created.json()

    const list = await server.inject({ method: 'GET', url: '/projects' })
    expect(list.json()).toEqual([project])

    const found = await server.inject({ method: 'GET', url: `/projects/${project.id}` })
    expect(found.json()).toEqual(project)

    const deleted = await server.inject({ method: 'DELETE', url: `/projects/${project.id}` })
    expect(deleted.statusCode).toBe(204)

    // the 'project.**' wildcard listener recorded both domain events
    expect(audit.entries.map((entry) => entry.event)).toEqual([
      'project.created',
      'project.deleted',
    ])
    expect(audit.entries[0]?.payload).toEqual(project)

    await app.shutdown()
  })

  it('validation and standardized errors traverse the whole stack', async () => {
    const { app, server } = await boot()

    const invalid = await server.inject({ method: 'POST', url: '/projects', payload: { name: 'ab' } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('HTTP_VALIDATION')

    const missing = await server.inject({ method: 'GET', url: '/projects/nao-existe' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('PROJECT_NOT_FOUND')

    await app.shutdown()
  })

  it('multi-tenancy: project data is isolated per tenant', async () => {
    const { app, server, audit } = await boot()
    const asTenant = (tenant: string) => ({ 'x-tenant-id': tenant })

    const created = await server.inject({
      method: 'POST',
      url: '/projects',
      headers: asTenant('acme'),
      payload: { name: 'Acme Project' },
    })
    expect(created.statusCode).toBe(201)

    // the same endpoint, three different worlds
    const acmeList = await server.inject({ method: 'GET', url: '/projects', headers: asTenant('acme') })
    const globexList = await server.inject({ method: 'GET', url: '/projects', headers: asTenant('globex') })
    const centralList = await server.inject({ method: 'GET', url: '/projects' })
    expect(acmeList.json()).toHaveLength(1)
    expect(globexList.json()).toEqual([])
    expect(centralList.json()).toEqual([])

    // the audit listener picked the tenant up from the context, not from the caller
    expect(audit.entries[0]).toMatchObject({ event: 'project.created', tenantId: 'acme' })
    await app.shutdown()
  })

  it('multi-tenancy: subdomain resolution and central fallback', async () => {
    const { app, server } = await boot()

    const viaSubdomain = await server.inject({
      method: 'GET',
      url: '/tenant',
      headers: { host: 'globex.localhost' },
    })
    expect(viaSubdomain.json()).toEqual({ id: 'globex', name: 'Globex Corp' })

    // unknown tenant id falls through the resolvers → central context
    const unknown = await server.inject({
      method: 'GET',
      url: '/tenant',
      headers: { 'x-tenant-id': 'ghost' },
    })
    expect(unknown.json()).toEqual({ id: null })
    await app.shutdown()
  })

  it('per-request context: requestId in the handler and in the response header', async () => {
    const { app, server } = await boot()
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-e2e' },
    })
    expect(res.json()).toEqual({ ok: true, requestId: 'req-e2e' })
    expect(res.headers['x-request-id']).toBe('req-e2e')
    await app.shutdown()
  })
})
