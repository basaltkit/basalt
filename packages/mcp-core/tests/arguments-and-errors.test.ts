import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { McpServer, RPC_ERRORS, serveHttp, serveStdio, type McpPromptDef, type McpToolDef } from '../src/index.js'

function spyTool(name = 'spy'): McpToolDef & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    name,
    description: '',
    inputSchema: { type: 'object' },
    async invoke(args) {
      calls.push(args)
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }
}

const leaky: McpToolDef = {
  name: 'leaky',
  description: '',
  inputSchema: { type: 'object' },
  async invoke() {
    throw new Error('pg: password S3cr3t rejected')
  },
}

const prompt: McpPromptDef = {
  name: 'p',
  arguments: [{ name: 'x' }],
  async get(args) {
    return { messages: [{ role: 'user', content: { type: 'text', text: JSON.stringify(args) } }] }
  },
}

const BAD_ARGUMENTS: unknown[] = [['a'], 'abc', 42, null, true]

describe('tools/call `arguments` shape', () => {
  it.each(BAD_ARGUMENTS)('rejects %j with INVALID_PARAMS and never invokes the tool', async (bad) => {
    const tool = spyTool()
    const server = new McpServer({ tools: [tool] })
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spy', arguments: bad },
    })
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    expect(res?.error?.message).toMatch(/arguments.*object/)
    expect(tool.calls).toHaveLength(0)
  })

  it('accepts a missing or empty-object `arguments`', async () => {
    const tool = spyTool()
    const server = new McpServer({ tools: [tool] })
    await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spy' } })
    await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spy', arguments: {} } })
    expect(tool.calls).toEqual([{}, {}])
  })
})

describe('prompts/get `arguments` shape', () => {
  it.each([...BAD_ARGUMENTS, { x: 1 }, { x: { nested: true } }])('rejects %j with INVALID_PARAMS', async (bad) => {
    const server = new McpServer({ prompts: [prompt] })
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'p', arguments: bad },
    })
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
  })

  it('accepts an object of strings', async () => {
    const server = new McpServer({ prompts: [prompt] })
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'p', arguments: { x: 'y' } },
    })
    expect(res?.error).toBeUndefined()
  })
})

describe('internal error sanitising', () => {
  it('answers a generic "Internal error" and hands the original to onError', async () => {
    const onError = vi.fn()
    const server = new McpServer({ tools: [leaky], onError })
    const message = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'leaky' } }
    const res = await server.handleMessage(message)
    expect(res?.error?.code).toBe(RPC_ERRORS.INTERNAL_ERROR)
    expect(res?.error?.message).toBe('Internal error')
    expect(JSON.stringify(res)).not.toContain('S3cr3t')
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as Error).message).toContain('S3cr3t')
    expect(onError.mock.calls[0]![1]).toBe(message)
  })

  it('keeps the message of an error marked `expose: true`', async () => {
    const exposed: McpToolDef = {
      ...leaky,
      name: 'exposed',
      async invoke() {
        throw Object.assign(new Error('Quota exceeded'), { expose: true })
      },
    }
    const server = new McpServer({ tools: [exposed] })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exposed' } })
    expect(res?.error?.message).toBe('Quota exceeded')
  })

  it('ignores a throwing onError hook', async () => {
    const server = new McpServer({
      tools: [leaky],
      onError: () => {
        throw new Error('hook')
      },
    })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'leaky' } })
    expect(res?.error?.message).toBe('Internal error')
  })

  it('sanitises a throwing resource read too', async () => {
    const server = new McpServer({
      resources: [
        {
          uri: 'x://r',
          name: 'r',
          async read() {
            throw new Error('/etc/secret path')
          },
        },
      ],
    })
    const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'x://r' } })
    expect(res?.error).toEqual({ code: RPC_ERRORS.INTERNAL_ERROR, message: 'Internal error' })
  })
})

describe('transports', () => {
  it('serveStdio: bad arguments -> INVALID_PARAMS; a throw -> "Internal error"', async () => {
    const tool = spyTool()
    const server = new McpServer({ tools: [tool, leaky] })
    const input = new PassThrough()
    const lines: Array<{ id: number; error?: { code: number; message: string } }> = []
    const handle = serveStdio(server, {
      input,
      output: {
        write(chunk: string) {
          for (const line of chunk.split('\n')) if (line.trim()) lines.push(JSON.parse(line))
          return true
        },
      },
    })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spy', arguments: 'abc' } })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'leaky' } })}\n`)
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
    handle.close()
    const byId = new Map(lines.map((l) => [l.id, l]))
    expect(byId.get(1)?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
    expect(byId.get(2)?.error).toEqual({ code: RPC_ERRORS.INTERNAL_ERROR, message: 'Internal error' })
    expect(tool.calls).toHaveLength(0)
  })

  it('serveHttp: bad arguments -> INVALID_PARAMS; a throw -> "Internal error"', async () => {
    const tool = spyTool()
    const server = new McpServer({ tools: [tool, leaky] })
    const handle = await serveHttp(server, { port: 0 })
    const post = async (message: unknown) => {
      const res = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      return (await res.json()) as { error?: { code: number; message: string } }
    }
    try {
      const bad = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'spy', arguments: [1] } })
      expect(bad.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
      const thrown = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'leaky' } })
      expect(thrown.error).toEqual({ code: RPC_ERRORS.INTERNAL_ERROR, message: 'Internal error' })
      expect(tool.calls).toHaveLength(0)
    } finally {
      await handle.close()
    }
  })
})
