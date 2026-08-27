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
