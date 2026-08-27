import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { McpServer, serveStdio, type McpToolDef } from '../src/index.js'

function collector() {
  const lines: unknown[] = []
  return {
    lines,
    output: {
      write(chunk: string) {
        for (const line of chunk.split('\n')) if (line.trim()) lines.push(JSON.parse(line))
        return true
      },
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

const whoami: McpToolDef = {
  name: 'whoami',
  description: 'Report the forwarded tenant header',
  inputSchema: { type: 'object' },
  async invoke(_args, ctx) {
    const tenant = ctx.headers?.['x-tenant-id'] ?? null
    return { content: [{ type: 'text', text: JSON.stringify({ tenant }) }], structuredContent: { tenant } }
  },
}

describe('serveStdio', () => {
  it('answers newline-delimited JSON-RPC, forwards headers, and stays silent for notifications', async () => {
    const server = new McpServer({ tools: [whoami], serverInfo: { name: 'stdio-demo', version: '1.2.3' } })
    const input = new PassThrough()
    const { lines, output } = collector()
    const handle = serveStdio(server, { input, output, headers: { 'x-tenant-id': 'globex' } })

    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }) // no reply expected
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
    await flush()
    await flush()

    expect(lines).toHaveLength(3)
    expect((lines[0] as { result: { serverInfo: object } }).result.serverInfo).toEqual({ name: 'stdio-demo', version: '1.2.3' })
    expect((lines[1] as { result: { tools: unknown[] } }).result.tools).toHaveLength(1)
    expect((lines[2] as { result: { structuredContent: { tenant: string } } }).result.structuredContent.tenant).toBe('globex')

    handle.close()
  })

  it('reports a parse error for malformed input', async () => {
    const server = new McpServer({ tools: [whoami] })
    const input = new PassThrough()
    const { lines, output } = collector()
    const handle = serveStdio(server, { input, output })
    input.write('not json\n')
    await flush()
    expect((lines[0] as { error: { code: number } }).error.code).toBe(-32700)
    handle.close()
  })
})

describe('serveStdio — progress + cancellation over the wire', () => {
  it('emits notifications/progress from a tool with a progressToken', async () => {
    const reporter: McpToolDef = {
      name: 'reporter',
      description: '',
      inputSchema: { type: 'object' },
      async invoke(_args, ctx) {
        ctx.progress?.({ progress: 1, total: 2, message: 'a' })
        ctx.progress?.({ progress: 2, total: 2, message: 'b' })
        return { content: [{ type: 'text', text: 'done' }] }
      },
    }
    const server = new McpServer({ tools: [reporter] })
    const input = new PassThrough()
    const { lines, output } = collector()
    const handle = serveStdio(server, { input, output })
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reporter', _meta: { progressToken: 't' } } })}\n`,
    )
    await flush()
    await flush()

    const progress = lines.filter((l): l is { method: string; params: Record<string, unknown> } => (l as { method?: string }).method === 'notifications/progress')
    expect(progress).toHaveLength(2)
    expect(progress[0]!.params).toMatchObject({ progressToken: 't', progress: 1, total: 2, message: 'a' })
    const result = lines.find((l) => (l as { id?: number }).id === 1) as { result: { content: Array<{ text: string }> } }
    expect(result.result.content[0]!.text).toBe('done')
    handle.close()
  })

  it('aborts an in-flight tool when notifications/cancelled arrives on the stream', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let captured: AbortSignal | undefined
    const slow: McpToolDef = {
      name: 'slow',
      description: '',
      inputSchema: { type: 'object' },
      async invoke(_args, ctx) {
        captured = ctx.signal
        await gate
        return { content: [{ type: 'text', text: ctx.signal.aborted ? 'aborted' : 'done' }] }
      },
    }
    const server = new McpServer({ tools: [slow] })
    const input = new PassThrough()
    const { lines, output } = collector()
    const handle = serveStdio(server, { input, output })

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow' } })}\n`)
    await flush()
    expect(captured?.aborted).toBe(false)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } })}\n`)
    await flush()
    expect(captured?.aborted).toBe(true)

    release()
    await flush()
    await flush()
    const res = lines.find((l) => (l as { id?: number }).id === 7) as { result: { content: Array<{ text: string }> } }
    expect(res.result.content[0]!.text).toBe('aborted')
    handle.close()
  })
})
