import { describe, expect, it } from 'vitest'
import { McpServer, serveHttp, type McpToolDef } from '../src/index.js'

const echo: McpToolDef = {
  name: 'echo',
  description: 'Echo the arguments',
  inputSchema: { type: 'object' },
  async invoke(args) {
    return { content: [{ type: 'text', text: JSON.stringify(args) }], structuredContent: args }
  },
}

async function rpc(url: string, message: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
  return { status: res.status, body: res.status === 202 ? null : await res.json() }
}

describe('serveHttp', () => {
  it('handles initialize -> tools/list -> tools/call over POST JSON-RPC', async () => {
    const server = new McpServer({ tools: [echo], serverInfo: { name: 'http-demo', version: '1.0.0' } })
    const handle = await serveHttp(server, { port: 0 })
    try {
      const init = await rpc(handle.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      expect(init.status).toBe(200)
      expect(init.body.result.serverInfo).toEqual({ name: 'http-demo', version: '1.0.0' })

      const list = await rpc(handle.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['echo'])

      const call = await rpc(handle.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
      expect(call.body.result.structuredContent).toEqual({ a: 1 })

      const notif = await rpc(handle.url, { jsonrpc: '2.0', method: 'notifications/initialized' })
      expect(notif.status).toBe(202)
    } finally {
      await handle.close()
    }
  })

  it('returns 400 on a malformed body and 404 off-path', async () => {
    const server = new McpServer({ tools: [echo] })
    const handle = await serveHttp(server, { port: 0, path: '/mcp' })
    try {
      const bad = await fetch(handle.url, { method: 'POST', body: 'not json' })
      expect(bad.status).toBe(400)
      const off = await fetch(handle.url.replace('/mcp', '/nope'), { method: 'POST', body: '{}' })
      expect(off.status).toBe(404)
    } finally {
      await handle.close()
    }
  })
})
