import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { MCP, LATEST_PROTOCOL_VERSION, RPC_ERRORS } from '../src/index.js'
import { basePlugins, makeRoutes, mcpRoutes } from './app.js'

async function server() {
  const routes = makeRoutes()
  const app = await createApp({
    plugins: [...basePlugins(routes), fastifyPlugin({ routes: [...routes, ...mcpRoutes()] })],
  }).boot()
  return { app, mcp: app.container.get(MCP) }
}

describe('McpServer protocol', () => {
  it('initialize negotiates the protocol version and returns serverInfo', async () => {
    const { app, mcp } = await server()
    const good = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
    expect(good?.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'test-app', version: '9.9.9' } })

    const unknown = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: 'ancient' } })
    expect((unknown?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
    await app.shutdown()
  })

  it('lists only the opted-in routes as tools, with merged input schemas', async () => {
    const { app, mcp } = await server()
    const res = await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema: { properties: object } }> }).tools
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['get_project', 'get_tags', 'get_whoami', 'post_projects']) // NOT get_secret
    const create = tools.find((t) => t.name === 'post_projects')!
    expect(create.inputSchema.properties).toHaveProperty('name')
    await app.shutdown()
  })

  it('calls a tool through the real pipeline and returns structured content', async () => {
    const { app, mcp } = await server()
    const res = await mcp.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'post_projects', arguments: { name: 'Basalt' } },
    })
    const result = res?.result as { content: Array<{ text: string }>; structuredContent: { id: string; name: string } }
    expect(result.structuredContent.name).toBe('Basalt')
    expect(JSON.parse(result.content[0]!.text).name).toBe('Basalt')
    await app.shutdown()
  })

  it('surfaces validation and domain errors as isError tool results', async () => {
    const { app, mcp } = await server()
    const bad = await mcp.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'post_projects', arguments: { name: 'ab' } }, // min(3) fails
    })
    const badResult = bad?.result as { isError: boolean; content: Array<{ text: string }> }
    expect(badResult.isError).toBe(true)
    expect(JSON.parse(badResult.content[0]!.text).code).toBe('HTTP_VALIDATION')

    const missing = await mcp.handleMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_project', arguments: { id: 'nope' } },
    })
    expect(JSON.parse((missing?.result as { content: Array<{ text: string }> }).content[0]!.text).code).toBe('PROJECT_NOT_FOUND')
    await app.shutdown()
  })

  it('propagates call headers (tenancy) into the tool', async () => {
    const { app, mcp } = await server()
    const res = await mcp.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_whoami', arguments: {} } },
      { headers: { 'x-tenant-id': 'acme' } },
    )
    expect((res?.result as { structuredContent: { tenant: string } }).structuredContent.tenant).toBe('acme')
    await app.shutdown()
  })

  it('coerces stringified numbers/booleans to the schema types (LLMs send text)', async () => {
    const { app, mcp } = await server()
    const res = await mcp.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'post_projects', arguments: { name: 'Basalt', order: '7' } }, // order as STRING
    })
    const result = res?.result as { isError?: boolean; structuredContent: { order: number } }
    expect(result.isError ?? false).toBe(false) // no 'expected number, received string'
    expect(result.structuredContent.order).toBe(7) // coerced to a real number
    await app.shutdown()
  })

  it('omits structuredContent for array/primitive returns (MCP wants a record)', async () => {
    const { app, mcp } = await server()
    const res = await mcp.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_tags', arguments: {} },
    })
    const result = res?.result as { content: Array<{ text: string }>; structuredContent?: unknown }
    expect('structuredContent' in result).toBe(false) // array → no structuredContent
    expect(JSON.parse(result.content[0]!.text)).toEqual(['a', 'b', 'c']) // data still in text
    await app.shutdown()
  })

  it('handles ping, unknown methods, unknown tools and notifications', async () => {
    const { app, mcp } = await server()
    expect((await mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }))?.result).toEqual({})

    const unknownMethod = await mcp.handleMessage({ jsonrpc: '2.0', id: 2, method: 'does/not/exist' })
    expect(unknownMethod?.error?.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND)

    const unknownTool = await mcp.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope' } })
    expect(unknownTool?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)

    // a notification (no id) never gets a response
    expect(await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    await app.shutdown()
  })
})
