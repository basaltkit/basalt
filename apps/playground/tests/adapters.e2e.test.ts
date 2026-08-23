import { describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { FASTIFY } from '@basaltkit/fastify'
import { EXPRESS } from '@basaltkit/express'
import { HONO } from '@basaltkit/hono'
import { buildApp, type Adapter } from '../src/app.js'

type Live = { url: string; close: () => Promise<void> }

/** Boot the playground on `adapter` and return a base URL backed by a real socket. */
async function start(adapter: Adapter): Promise<Live> {
  const app = await buildApp({ logLevel: 'silent', adapter }).boot()

  if (adapter === 'express') {
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return { url: `http://127.0.0.1:${port}`, close: () => app.shutdown() }
  }
  if (adapter === 'hono') {
    const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>(
      (resolve) => {
        const s = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
          resolve({ server: s as unknown as { close: (cb: () => void) => void }, port: info.port }),
        )
      },
    )
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())).then(() => app.shutdown()),
    }
  }
  const server = app.container.get(FASTIFY)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => app.shutdown() }
}

const adapters: Adapter[] = ['fastify', 'express', 'hono']

describe.each(adapters)('playground on the %s adapter', (adapter) => {
  it('runs the identical route() list: CRUD, validation, tenancy and requestId', async () => {
    const live = await start(adapter)
    const json = (p: string, init?: RequestInit) => fetch(`${live.url}${p}`, init)
    try {
      // create → list → fetch → delete
      const created = await json('/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Basalt' }),
      })
      expect(created.status).toBe(201)
      const project = (await created.json()) as { id: string; name: string }
      expect(project.name).toBe('Basalt')

      const list = await (await json('/projects')).json()
      expect(list).toEqual([project])

      const found = await (await json(`/projects/${project.id}`)).json()
      expect(found).toEqual(project)

      const deleted = await json(`/projects/${project.id}`, { method: 'DELETE' })
      expect(deleted.status).toBe(204)

      // validation error, same envelope on every adapter
      const invalid = await json('/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ab' }),
      })
      expect(invalid.status).toBe(400)
      expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('HTTP_VALIDATION')

      // 404 domain error
      const missing = await json('/projects/does-not-exist')
      expect(missing.status).toBe(404)
      expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('PROJECT_NOT_FOUND')

      // tenancy is resolved from the header on every adapter
      await json('/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant-id': 'acme' },
        body: JSON.stringify({ name: 'Acme Project' }),
      })
      const acme = await (await json('/projects', { headers: { 'x-tenant-id': 'acme' } })).json()
      const globex = await (await json('/projects', { headers: { 'x-tenant-id': 'globex' } })).json()
      expect(acme).toHaveLength(1)
      expect(globex).toEqual([])

      // per-request context surfaces requestId in the handler
      const health = await (await json('/health', { headers: { 'x-request-id': 'req-xyz' } })).json()
      expect(health).toEqual({ ok: true, requestId: 'req-xyz' })
    } finally {
      await live.close()
    }
  })
})
