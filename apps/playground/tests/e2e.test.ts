import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@machize/fastify'
import { buildApp } from '../src/app.js'
import { AUDIT } from '../src/domain.js'

async function boot() {
  const app = await buildApp({ logLevel: 'silent' }).boot()
  return { app, server: app.container.get(FASTIFY), audit: app.container.get(AUDIT) }
}

describe('playground E2E — Fase 1 integrada', () => {
  it('fluxo completo: criar, listar, buscar, deletar — com auditoria via eventos', async () => {
    const { app, server, audit } = await boot()

    const created = await server.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Machize' },
    })
    expect(created.statusCode).toBe(201)
    const project = created.json()

    const list = await server.inject({ method: 'GET', url: '/projects' })
    expect(list.json()).toEqual([project])

    const found = await server.inject({ method: 'GET', url: `/projects/${project.id}` })
    expect(found.json()).toEqual(project)

    const deleted = await server.inject({ method: 'DELETE', url: `/projects/${project.id}` })
    expect(deleted.statusCode).toBe(204)

    // o listener wildcard 'project.**' registrou os dois eventos de domínio
    expect(audit.entries.map((entry) => entry.event)).toEqual([
      'project.created',
      'project.deleted',
    ])
    expect(audit.entries[0]?.payload).toEqual(project)

    await app.shutdown()
  })

  it('validação e erros padronizados atravessam a pilha inteira', async () => {
    const { app, server } = await boot()

    const invalid = await server.inject({ method: 'POST', url: '/projects', payload: { name: 'ab' } })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json().error.code).toBe('HTTP_VALIDATION')

    const missing = await server.inject({ method: 'GET', url: '/projects/nao-existe' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('PROJECT_NOT_FOUND')

    await app.shutdown()
  })

  it('contexto por request: requestId no handler e no header de resposta', async () => {
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
