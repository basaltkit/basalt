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

  it('rejects non-object `arguments` with INVALID_PARAMS before dispatch', async () => {
    const res = await server().handleMessage({
      jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_item', arguments: 5 },
    })
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    expect(res?.error?.message).not.toMatch(/TypeError/)
  })

  it('stays silent when a notification throws during dispatch', async () => {
    // A request method sent as a notification (no id) is never executed or answered.
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

describe('McpServer onError (internal errors)', () => {
  // Every route tool converts its own failures to `isError` results, so an
  // internal error is a bug that escaped it. Simulate one by replacing a tool's
  // invoke inside the core (white-box: no public path throws there).
  function breakTool(server: McpServer): void {
    const core = (server as unknown as { core: { tools: Map<string, { invoke: () => never }> } }).core
    core.tools.get('get_hello')!.invoke = () => {
      throw new Error('escaped bug: /secret/path')
    }
  }
  const call = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'get_hello', arguments: {} } }

  it('reports the original error to onError and keeps it from the client', async () => {
    const seen: Array<{ error: unknown; method: string }> = []
    const server = new McpServer({
      routes,
      container,
      onError: (error, message) => seen.push({ error, method: message.method }),
    })
    breakTool(server)
    const res = await server.handleMessage(call)
    expect(res?.error).toMatchObject({ code: RPC_ERRORS.INTERNAL_ERROR, message: 'Internal error' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('tools/call')
    expect(String(seen[0]!.error)).toMatch(/escaped bug/)
  })

  it('writes to stderr by default, and onError: false silences it', async () => {
    const writes: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const loud = new McpServer({ routes, container })
      const quiet = new McpServer({ routes, container, onError: false })
      breakTool(loud)
      breakTool(quiet)
      await loud.handleMessage(call)
      expect(writes.join('')).toMatch(/\[basalt:mcp\] internal error in tools\/call — Error: escaped bug/)
      writes.length = 0
      await quiet.handleMessage(call)
      expect(writes.join('')).toBe('')
    } finally {
      process.stderr.write = original
    }
  })
})
