import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { MCP_CLIENTS, mcpClientPlugin } from '../src/index.js'
import { basePlugins, makeRoutes, mcpRoutes } from './app.js'

/** A standalone MCP server app on a real socket, to be consumed as a client. */
async function startServer() {
  const routes = makeRoutes()
  const app = await createApp({
    plugins: [...basePlugins(routes), fastifyPlugin({ routes: [...routes, ...mcpRoutes()] })],
  }).boot()
  const server = app.container.get(FASTIFY)
  await server.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { app, url: `http://127.0.0.1:${port}/mcp` }
}

describe('mcpClientPlugin', () => {
  it('connects to external servers at boot and exposes their tools via MCP_CLIENTS', async () => {
    const server = await startServer()
    const client = await createApp({
      plugins: [
        mcpClientPlugin({
          servers: { remote: { type: 'http', url: server.url, headers: { 'x-tenant-id': 'acme' } } },
        }),
      ],
    }).boot()

    const clients = client.container.get(MCP_CLIENTS)
    expect(clients.names()).toEqual(['remote'])

    const { tools } = await clients.listTools('remote')
    expect(tools.map((t) => t.name).sort()).toEqual(['get_project', 'get_tags', 'get_whoami', 'post_projects'])

    const created = await clients.callTool('remote', 'post_projects', { name: 'Basalt' })
    expect((created.structuredContent as { name: string; tenant: string }).name).toBe('Basalt')
    expect((created.structuredContent as { tenant: string }).tenant).toBe('acme') // client headers propagate

    await client.shutdown()
    await server.app.shutdown()
  })

  it('supports lazy connection (eager: false)', async () => {
    const server = await startServer()
    const client = await createApp({
      plugins: [mcpClientPlugin({ servers: { remote: { type: 'http', url: server.url } }, eager: false })],
    }).boot()

    // not connected at boot, but callTool connects on demand
    const result = await client.container.get(MCP_CLIENTS).callTool('remote', 'get_whoami', {})
    expect((result.structuredContent as { tenant: string | null }).tenant).toBeNull()

    await client.shutdown()
    await server.app.shutdown()
  })

  it('throws for an unknown server name', async () => {
    const app = await createApp({
      plugins: [mcpClientPlugin({ servers: {}, eager: false })],
    }).boot()
    await expect(app.container.get(MCP_CLIENTS).callTool('nope', 'x')).rejects.toThrow(/Unknown MCP server/)
    await app.shutdown()
  })
})
