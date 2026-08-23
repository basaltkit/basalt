import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { serveMcpStdio, McpClient, StdioClientTransport } from '../src/index.js'
import { basePlugins, makeRoutes, mcpRoutes } from './app.js'

/** Collects newline-delimited JSON responses written by the stdio server. */
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

describe('serveMcpStdio', () => {
  it('answers newline-delimited JSON-RPC and stays silent for notifications', async () => {
    const routes = makeRoutes()
    const app = await createApp({
      plugins: [...basePlugins(routes), fastifyPlugin({ routes: [...routes, ...mcpRoutes()] })],
    }).boot()

    const input = new PassThrough()
    const { lines, output } = collector()
    const handle = serveMcpStdio(app, { input, output, headers: { 'x-tenant-id': 'globex' } })

    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`)
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }) // no reply expected
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_whoami', arguments: {} } })
    await flush()
    await flush()

    // three responses (init, tools/list, tools/call) — the notification produced none
    expect(lines).toHaveLength(3)
    expect((lines[0] as { result: { serverInfo: object } }).result.serverInfo).toEqual({ name: 'test-app', version: '9.9.9' })
    expect((lines[1] as { result: { tools: unknown[] } }).result.tools).toHaveLength(3)
    // static stdio headers propagate into the tool
    expect((lines[2] as { result: { structuredContent: { tenant: string } } }).result.structuredContent.tenant).toBe('globex')

    handle.close()
    await app.shutdown()
  })
})

// A tiny stdio MCP server (canned responses) to exercise the client transport
// end-to-end: spawn, newline framing, id-matching and notifications.
const ECHO_SERVER = `
process.stdin.setEncoding('utf8'); let buf='';
process.stdin.on('data', d => { buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0,i).trim(); buf = buf.slice(i+1);
    if (!l) continue; const m = JSON.parse(l); if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'echo', version: '1' } };
    else if (m.method === 'tools/list') result = { tools: [{ name: 'echo', description: '', inputSchema: { type: 'object' } }] };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify(m.params.arguments) }], structuredContent: m.params.arguments };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`

describe('StdioClientTransport', () => {
  it('spawns a server and round-trips initialize / list / call', async () => {
    const client = new McpClient(new StdioClientTransport({ command: process.execPath, args: ['-e', ECHO_SERVER] }))
    try {
      const init = await client.connect()
      expect(init.serverInfo.name).toBe('echo')
      const { tools } = await client.listTools()
      expect(tools[0]!.name).toBe('echo')
      const result = await client.callTool('echo', { a: 1, b: 'x' })
      expect(result.structuredContent).toEqual({ a: 1, b: 'x' })
    } finally {
      await client.close()
    }
  })
})
