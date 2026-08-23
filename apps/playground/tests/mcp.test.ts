import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@basaltkit/fastify'
import { buildApp } from '../src/app.js'

async function boot() {
  const app = await buildApp({ logLevel: 'silent' }).boot()
  const server = app.container.get(FASTIFY)
  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    server.inject({ method: 'POST', url: '/mcp', payload: body as object, headers }).then((r) => r.json())
  return { app, rpc }
}

describe('playground MCP endpoint', () => {
  it('lists the opted-in project tools', async () => {
    const { app, rpc } = await boot()
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = (res.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(['create_project', 'get_project', 'list_projects'])
    await app.shutdown()
  })

  it('creates and lists a project through tools, honouring the tenant header', async () => {
    const { app, rpc } = await boot()
    const tenant = { 'x-tenant-id': 'acme' }

    const created = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'Basalt' } } },
      tenant,
    )
    expect(created.result.structuredContent.name).toBe('Basalt')

    const listed = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
      tenant,
    )
    expect(listed.result.structuredContent).toHaveLength(1)

    // a different tenant sees none — isolation holds through MCP
    const other = await rpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } },
      { 'x-tenant-id': 'globex' },
    )
    expect(other.result.structuredContent).toEqual([])
    await app.shutdown()
  })
})
