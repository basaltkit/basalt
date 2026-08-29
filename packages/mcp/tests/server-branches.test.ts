import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type Container } from '@basaltkit/core'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { LATEST_PROTOCOL_VERSION, McpServer, MCP, mcpPlugin, mcpRoutes, RPC_ERRORS } from '../src/index.js'

const routes: BasaltRoute[] = [
  route({
    method: 'GET',
    url: '/hello',
    meta: { mcp: true },
    async handler() {
      return { hello: true }
    },
  }),
  // Has a params schema — invoked with non-object arguments, splitArgs throws.
  route({
    method: 'GET',
    url: '/item/:id',
    meta: { mcp: { name: 'get_item' } },
    params: z.object({ id: z.string() }),
    async handler({ params }) {
      return { id: params.id }
    },
  }),
  route({
    method: 'GET',
    url: '/other',
    meta: { mcp: true },
    async handler() {
      return { other: true }
    },
  }),
]

let container: Container
let shutdown: () => Promise<void>

beforeAll(async () => {
  const app = await createApp({ plugins: [] }).boot()
  container = app.container
  shutdown = () => app.shutdown()
})

afterAll(async () => {
  await shutdown()
})

describe('McpServer constructor', () => {
  it('falls back to the default serverInfo when none is given', () => {
    const server = new McpServer({ routes, container })
    expect(server.serverInfo).toEqual({ name: 'basalt', version: '0.1.0' })
  })

  it('accepts a filter option', () => {
    const server = new McpServer({
      routes,
      container,
      serverInfo: { name: 'x', version: '1' },
      filter: (r) => r.url === '/hello',
    })
    expect(server.listTools().map((t) => t.name)).toEqual(['get_hello'])
  })
})

describe('McpServer.callTool', () => {
  it('throws for an unknown tool name', async () => {
    const server = new McpServer({ routes, container })
    await expect(server.callTool('nope', {})).rejects.toThrow('Unknown tool: nope')
  })
})

describe('McpServer.handleMessage — malformed requests', () => {
  const server = () => new McpServer({ routes, container })

  it('rejects a null message with a null id', async () => {
    const res = await server().handleMessage(null as never)
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_REQUEST)
    expect(res?.id).toBeNull()
  })

  it('rejects a wrong jsonrpc version, echoing the id', async () => {
    const res = await server().handleMessage({ jsonrpc: '1.0', id: 9, method: 'ping' } as never)
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_REQUEST)
    expect(res?.id).toBe(9)
  })

  it('rejects a non-string method', async () => {
    const res = await server().handleMessage({ jsonrpc: '2.0', id: 9 } as never)
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_REQUEST)
  })
})

describe('McpServer.handleMessage — defaults and edge cases', () => {
  const server = () => new McpServer({ routes, container })

  it('initialize without params negotiates the latest protocol version', async () => {
    const res = await server().handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
  })

  it('tools/call without params fails with INVALID_PARAMS (no name)', async () => {
    const res = await server().handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call' })
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
  })

  it('tools/call with a non-string name fails with INVALID_PARAMS', async () => {
    const res = await server().handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 123 },
    })
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
  })

  it('tools/call defaults arguments to {} when omitted', async () => {
    const res = await server().handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_hello' },
    })
    expect((res?.result as { structuredContent: { hello: boolean } }).structuredContent.hello).toBe(true)
  })

  it('stays silent for an unknown-method notification (no id)', async () => {
    const res = await server().handleMessage({ jsonrpc: '2.0', method: 'weird/method' })
    expect(res).toBeNull()
  })

  it('surfaces an internal error when a tool call throws before dispatch', async () => {
    // Non-object `arguments` makes splitArgs throw a TypeError → the catch path.
    const res = await server().handleMessage({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_item', arguments: 5 },
    })
    expect(res?.error?.code).toBe(RPC_ERRORS.INTERNAL_ERROR)
    expect(typeof res?.error?.message).toBe('string')
  })

  it('stays silent when a notification throws during dispatch', async () => {
    // Same throwing call, but as a notification (no id) → catch returns null.
    const res = await server().handleMessage({
      jsonrpc: '2.0', method: 'tools/call', params: { name: 'get_item', arguments: 5 },
    })
    expect(res).toBeNull()
  })
})

describe('mcpPlugin', () => {
  it('registers a server with the default serverInfo and applies the filter', async () => {
    const app = await createApp({
      plugins: [mcpPlugin({ routes, filter: (r) => r.url !== '/other' })],
    }).boot()
    const server = app.container.get(MCP)
    expect(server.serverInfo).toEqual({ name: 'basalt', version: '0.1.0' })
    const names = server.listTools().map((t) => t.name).sort()
    expect(names).toEqual(['get_hello', 'get_item'])
    await app.shutdown()
  })
})

describe('mcpRoutes rate-limit meta (A-2)', () => {
  it('stamps meta.rateLimit on the /mcp route so securityPlugin gives it a dedicated budget', () => {
    const [r] = mcpRoutes({ rateLimit: { limit: 5, windowMs: 60_000 } })
    expect(r!.meta).toMatchObject({ rateLimit: { limit: 5, windowMs: 60_000 } })
  })

  it('emits no rateLimit meta by default', () => {
    const [r] = mcpRoutes()
    expect(r!.meta?.['rateLimit']).toBeUndefined()
  })
})
