import { describe, expect, it } from 'vitest'
import { FASTIFY } from '@basaltkit/fastify'
import { buildApp } from '../src/app.js'

async function boot() {
  const app = await buildApp({ logLevel: 'silent' }).boot()
  const server = app.container.get(FASTIFY)
  const post = (body: unknown, headers: Record<string, string>) =>
    server.inject({ method: 'POST', url: '/mcp', payload: body as object, headers })
  // `/mcp` is session-bound: `initialize` issues an `Mcp-Session-Id` that every
  // later request of the same caller carries.
  const session = async (headers: Record<string, string> = {}) => {
    const init = await post(
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      headers,
    )
    const id = init.headers['mcp-session-id']
    if (typeof id !== 'string') throw new Error(`initialize issued no session (${init.statusCode})`)
    return (body: unknown) => post(body, { ...headers, 'mcp-session-id': id }).then((r) => r.json())
  }
  return { app, session }
}

describe('playground MCP endpoint', () => {
  it('lists the opted-in project tools', async () => {
    const { app, session } = await boot()
    const rpc = await session()
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = (res.result.tools as Array<{ name: string }>).map((t) => t.name).sort()
    expect(names).toEqual(['create_project', 'get_project', 'list_projects'])
    await app.shutdown()
  })

  it('creates and lists a project through tools, honouring the tenant header', async () => {
    const { app, session } = await boot()
    const rpc = await session({ 'x-tenant-id': 'acme' })

    const created = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_project', arguments: { name: 'Basalt' } } },
    )
    expect(created.result.structuredContent.name).toBe('Basalt')

    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })
    // Array results carry their data in `content` (as JSON text), not
    // `structuredContent` — MCP only sets structuredContent for plain objects
    // (Claude Desktop rejects array structuredContent). See @basaltkit/mcp.
    const listRows = (r: typeof listed) => JSON.parse(r.result.content[0].text) as unknown[]
    expect(listRows(listed)).toHaveLength(1)

    // a different tenant sees none — isolation holds through MCP
    const globex = await session({ 'x-tenant-id': 'globex' })
    const other = await globex({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } })
    expect(listRows(other)).toEqual([])
    await app.shutdown()
  })
})
