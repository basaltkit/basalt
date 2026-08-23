import { describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { expressPlugin, EXPRESS } from '@basaltkit/express'
import { honoPlugin, HONO } from '@basaltkit/hono'
import { McpClient, HttpClientTransport } from '../src/index.js'
import { basePlugins, makeRoutes, mcpRoutes } from './app.js'

type Live = { url: string; close: () => Promise<void> }

async function start(adapter: 'fastify' | 'express' | 'hono'): Promise<Live> {
  const routes = makeRoutes()
  const all = [...routes, ...mcpRoutes()]
  const plugin =
    adapter === 'express'
      ? expressPlugin({ routes: all })
      : adapter === 'hono'
        ? honoPlugin({ routes: all })
        : fastifyPlugin({ routes: all })
  const app = await createApp({ plugins: [...basePlugins(routes), plugin] }).boot()

  if (adapter === 'express') {
    const server = app.container.get(EXPRESS).listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return { url: `http://127.0.0.1:${port}/mcp`, close: () => app.shutdown() }
  }
  if (adapter === 'hono') {
    const { server, port } = await new Promise<{ server: { close: (cb: () => void) => void }; port: number }>(
      (resolve) => {
        const s = serve({ fetch: app.container.get(HONO).fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
          resolve({ server: s as unknown as { close: (cb: () => void) => void }, port: info.port }),
        )
      },
    )
    return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((r) => server.close(() => r())).then(() => app.shutdown()) }
  }
  const server = app.container.get(FASTIFY)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => app.shutdown() }
}

describe.each(['fastify', 'express', 'hono'] as const)('MCP over HTTP on the %s adapter', (adapter) => {
  it('client can initialize, list tools and call one — identically', async () => {
    const live = await start(adapter)
    const client = new McpClient(new HttpClientTransport(live.url, { headers: { 'x-tenant-id': 'acme' } }))
    try {
      const init = await client.connect()
      expect(init.serverInfo).toEqual({ name: 'test-app', version: '9.9.9' })

      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'get_whoami', 'post_projects'])

      const created = await client.callTool('post_projects', { name: 'Basalt' })
      const project = created.structuredContent as { id: string; name: string; tenant: string }
      expect(project.name).toBe('Basalt')
      expect(project.tenant).toBe('acme') // header propagated through the pipeline

      const fetched = await client.callTool('get_project', { id: project.id })
      expect((fetched.structuredContent as { name: string }).name).toBe('Basalt')

      const bad = await client.callTool('post_projects', { name: 'ab' })
      expect(bad.isError).toBe(true)
    } finally {
      await client.close()
      await live.close()
    }
  })
})
