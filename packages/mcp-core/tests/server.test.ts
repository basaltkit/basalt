import { describe, expect, it } from 'vitest'
import {
  McpServer,
  RPC_ERRORS,
  LATEST_PROTOCOL_VERSION,
  type McpToolDef,
  type McpResourceDef,
  type McpPromptDef,
  type ToolInvokeContext,
} from '../src/index.js'

const echoTool: McpToolDef = {
  name: 'echo',
  description: 'Echo the arguments back',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  async invoke(args) {
    return {
      content: [{ type: 'text', text: JSON.stringify(args) }],
      structuredContent: args,
    }
  },
}

describe('McpServer — protocol surface', () => {
  it('initialize negotiates the version and advertises only tools by default', async () => {
    const server = new McpServer({ tools: [echoTool], serverInfo: { name: 'demo', version: '2.0.0' } })
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' },
    })
    expect(res?.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'demo', version: '2.0.0' },
    })
    // no resources/prompts registered → not advertised
    expect((res?.result as { capabilities: Record<string, unknown> }).capabilities['resources']).toBeUndefined()
    expect((res?.result as { capabilities: Record<string, unknown> }).capabilities['prompts']).toBeUndefined()
  })

  it('falls back to the latest protocol version for an unknown request', async () => {
    const server = new McpServer({ tools: [echoTool] })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'ancient' } })
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe(LATEST_PROTOCOL_VERSION)
  })

  it('lists and calls a function tool, returning structured content', async () => {
    const server = new McpServer({ tools: [echoTool] })
    const list = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(['echo'])

    const call = await server.handleMessage({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } },
    })
    const result = call?.result as { content: Array<{ text: string }>; structuredContent: { text: string } }
    expect(result.structuredContent.text).toBe('hi')
    expect(JSON.parse(result.content[0]!.text).text).toBe('hi')
  })

  it('ping, malformed requests, unknown methods, unknown tools and notifications', async () => {
    const server = new McpServer({ tools: [echoTool] })
    expect((await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }))?.result).toEqual({})

    const bad = await server.handleMessage({ jsonrpc: '1.0', id: 9, method: 'ping' } as never)
    expect(bad?.error?.code).toBe(RPC_ERRORS.INVALID_REQUEST)
    expect(bad?.id).toBe(9)

    const nullMsg = await server.handleMessage(null as never)
    expect(nullMsg?.id).toBeNull()
    expect(nullMsg?.error?.code).toBe(RPC_ERRORS.INVALID_REQUEST)

    const unknownMethod = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'does/not/exist' })
    expect(unknownMethod?.error?.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND)

    const noName = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })
    expect(noName?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)

    const unknownTool = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })
    expect(unknownTool?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)

    // resources/prompts methods are METHOD_NOT_FOUND when none are registered
    const noResources = await server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' })
    expect(noResources?.error?.code).toBe(RPC_ERRORS.METHOD_NOT_FOUND)

    // a notification never gets a response
    expect(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await server.handleMessage({ jsonrpc: '2.0', method: 'weird/method' })).toBeNull()
  })

  it('surfaces a thrown tool error as INTERNAL_ERROR (and stays silent as a notification)', async () => {
    const boom: McpToolDef = {
      name: 'boom', description: '', inputSchema: { type: 'object' },
      async invoke() { throw new Error('kaboom') },
    }
    const server = new McpServer({ tools: [boom] })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom' } })
    expect(res?.error?.code).toBe(RPC_ERRORS.INTERNAL_ERROR)
    expect(res?.error?.message).toBe('kaboom')

    const asNotification = await server.handleMessage({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'boom' } })
    expect(asNotification).toBeNull()
  })

  it('callTool throws for an unknown name', async () => {
    const server = new McpServer({ tools: [echoTool] })
    await expect(server.callTool('nope', {})).rejects.toThrow('Unknown tool: nope')
  })
})

describe('McpServer — signal + progress plumbing', () => {
  it('passes an AbortSignal into the tool and aborts it on notifications/cancelled', async () => {
    let captured: AbortSignal | undefined
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const slow: McpToolDef = {
      name: 'slow', description: '', inputSchema: { type: 'object' },
      async invoke(_args, ctx: ToolInvokeContext) {
        captured = ctx.signal
        await gate
        return { content: [{ type: 'text', text: ctx.signal.aborted ? 'aborted' : 'done' }] }
      },
    }
    const server = new McpServer({ tools: [slow] })
    const pending = server.handleMessage({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'slow' } })
    // give the invoke a tick to register
    await new Promise((r) => setImmediate(r))
    expect(captured?.aborted).toBe(false)
    const cancel = await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } })
    expect(cancel).toBeNull()
    expect(captured?.aborted).toBe(true)
    release()
    const res = await pending
    expect((res?.result as { content: Array<{ text: string }> }).content[0]!.text).toBe('aborted')
  })

  it('synthesizes a progress callback from a progressToken + notify', async () => {
    const sent: unknown[] = []
    const reporter: McpToolDef = {
      name: 'report', description: '', inputSchema: { type: 'object' },
      async invoke(_args, ctx: ToolInvokeContext) {
        ctx.progress?.({ progress: 1, total: 2, message: 'half' })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }
    const server = new McpServer({ tools: [reporter] })
    await server.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'report', _meta: { progressToken: 'tok-1' } } },
      { notify: (m) => sent.push(m) },
    )
    expect(sent).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok-1', progress: 1, total: 2, message: 'half' } },
    ])
  })
})

describe('McpServer — resources & prompts', () => {
  const resource: McpResourceDef = {
    uri: 'demo://context',
    name: 'context',
    description: 'the project context',
    mimeType: 'application/json',
    read() { return { text: '{"ok":true}' } },
  }
  const prompt: McpPromptDef = {
    name: 'greet',
    description: 'greeting template',
    arguments: [{ name: 'who', required: true }],
    get(args) { return { messages: [{ role: 'user', content: { type: 'text', text: `Hi ${args['who']}` } }] } },
  }

  it('advertises resources/prompts capabilities and serves them when registered', async () => {
    const server = new McpServer({ tools: [echoTool], resources: [resource], prompts: [prompt] })
    const init = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect((init?.result as { capabilities: Record<string, unknown> }).capabilities).toEqual({
      tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false },
    })

    const rList = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    expect((rList?.result as { resources: Array<{ uri: string }> }).resources[0]!.uri).toBe('demo://context')

    const rRead = await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'demo://context' } })
    expect((rRead?.result as { contents: Array<{ text: string; mimeType: string }> }).contents[0]).toEqual({
      uri: 'demo://context', mimeType: 'application/json', text: '{"ok":true}',
    })

    const pList = await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'prompts/list' })
    expect((pList?.result as { prompts: Array<{ name: string }> }).prompts[0]!.name).toBe('greet')

    const pGet = await server.handleMessage({ jsonrpc: '2.0', id: 5, method: 'prompts/get', params: { name: 'greet', arguments: { who: 'Ada' } } })
    expect((pGet?.result as { messages: Array<{ content: { text: string } }> }).messages[0]!.content.text).toBe('Hi Ada')
  })

  it('unknown resource / prompt names fail with INVALID_PARAMS', async () => {
    const server = new McpServer({ resources: [resource], prompts: [prompt] })
    const r = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'demo://missing' } })
    expect(r?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    const p = await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'missing' } })
    expect(p?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
  })
})
