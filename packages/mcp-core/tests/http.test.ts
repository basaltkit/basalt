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

import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'

/** POST to the handle with fully-controlled Host/Origin headers (fetch can't set a foreign Host). */
function rawPost(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })

describe('serveHttp — DNS-rebinding + CSRF guard', () => {
  it('rejects a foreign Host header with 403 (anti-DNS-rebinding)', async () => {
    const handle = await serveHttp(new McpServer({ tools: [echo] }), { port: 0 })
    try {
      const res = await rawPost(handle.port, '/mcp', { host: 'evil.com' }, INIT)
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body).error.message).toMatch(/host\/origin/i)
    } finally {
      await handle.close()
    }
  })

  it('rejects a foreign Origin header with 403 (anti-CSRF), even with a loopback Host', async () => {
    const handle = await serveHttp(new McpServer({ tools: [echo] }), { port: 0 })
    try {
      const res = await rawPost(handle.port, '/mcp', { host: `127.0.0.1:${handle.port}`, origin: 'http://evil.com' }, INIT)
      expect(res.status).toBe(403)
    } finally {
      await handle.close()
    }
  })

  it('allows a loopback Host with NO Origin (non-browser client) — normal handshake works', async () => {
    const handle = await serveHttp(new McpServer({ tools: [echo], serverInfo: { name: 'guard', version: '1' } }), { port: 0 })
    try {
      const res = await rawPost(handle.port, '/mcp', { host: `localhost:${handle.port}` }, INIT)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body).result.serverInfo.name).toBe('guard')
    } finally {
      await handle.close()
    }
  })

  it('allows a loopback Origin', async () => {
    const handle = await serveHttp(new McpServer({ tools: [echo] }), { port: 0 })
    try {
      const res = await rawPost(
        handle.port,
        '/mcp',
        { host: `127.0.0.1:${handle.port}`, origin: `http://localhost:${handle.port}` },
        INIT,
      )
      expect(res.status).toBe(200)
    } finally {
      await handle.close()
    }
  })

  it('honours allowedHosts / allowedOrigins for a deliberate non-loopback bind', async () => {
    const handle = await serveHttp(new McpServer({ tools: [echo] }), {
      port: 0,
      allowedHosts: ['ci.internal'],
      allowedOrigins: ['https://ci.internal'],
    })
    try {
      const ok = await rawPost(handle.port, '/mcp', { host: 'ci.internal', origin: 'https://ci.internal' }, INIT)
      expect(ok.status).toBe(200)
      const bad = await rawPost(handle.port, '/mcp', { host: 'ci.internal', origin: 'https://evil.com' }, INIT)
      expect(bad.status).toBe(403)
    } finally {
      await handle.close()
    }
  })
})

describe('serveHttp — transport details (FA-H23, Melhorias 8)', () => {
  it('hands a tool every value of a repeated header, instead of one comma-joined (or first-wins) string', async () => {
    let seen: Record<string, string | string[] | undefined> | undefined
    const capture: McpToolDef = {
      name: 'capture',
      description: 'Capture the headers',
      inputSchema: { type: 'object' },
      async invoke(_args, ctx) {
        seen = ctx.headers
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    }
    const handle = await serveHttp(new McpServer({ tools: [capture] }), { port: 0 })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: handle.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-tenant': ['acme', 'globex'],
              authorization: ['Bearer one', 'Bearer two'],
              'x-single': 'only',
            } as unknown as OutgoingHttpHeaders, // node:http sends an array as repeated lines
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'capture', arguments: {} } }))
      })
      expect(status).toBe(200)
      expect(seen?.['x-tenant']).toEqual(['acme', 'globex'])
      expect(seen?.['authorization']).toEqual(['Bearer one', 'Bearer two'])
      expect(seen?.['x-single']).toBe('only')
    } finally {
      await handle.close()
    }
  })

  it('builds a valid URL for an IPv6 bind (host: "::1")', async () => {
    const handle = await serveHttp(new McpServer({ tools: [echo] }), { port: 0, host: '::1' }).catch((error: NodeJS.ErrnoException) => {
      // No IPv6 loopback on this machine: nothing to check here.
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') return undefined
      throw error
    })
    if (!handle) return
    try {
      expect(handle.url).toBe(`http://[::1]:${handle.port}/mcp`)
      const init = await rpc(handle.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      expect(init.status).toBe(200)
    } finally {
      await handle.close()
    }
  })

  it('rejects instead of hanging when the port cannot be bound', async () => {
    const first = await serveHttp(new McpServer({ tools: [echo] }), { port: 0 })
    try {
      await expect(serveHttp(new McpServer({ tools: [echo] }), { port: first.port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally {
      await first.close()
    }
  })
})
