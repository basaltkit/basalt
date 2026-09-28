import { request as httpRequest } from 'node:http'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { dispatchPayload, McpServer, serveHttp, serveStdio, type McpToolDef } from '../src/index.js'

const rpc = (id: number | null, method: string, params?: unknown) => ({
  jsonrpc: '2.0' as const,
  ...(id === null ? {} : { id }),
  method,
  ...(params ? { params } : {}),
})
const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms))

/** A tool that resolves 'aborted' as soon as its signal fires, else 'done' after `ms`. */
const slow = (ms = 300): McpToolDef => ({
  name: 'slow',
  description: '',
  inputSchema: { type: 'object' },
  invoke: (_a, c) =>
    new Promise((resolve) => {
      c.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'aborted' }] }))
      setTimeout(() => resolve({ content: [{ type: 'text', text: 'done' }] }), ms)
    }),
})

// FA-037 — cancellation scope and notification-form requests.
describe('McpServer — in-flight registry is scoped per session', () => {
  it("a cancel from session B does not abort session A's request with the same id", async () => {
    const server = new McpServer({ tools: [slow()] })
    const a = server.handleMessage(rpc(1, 'tools/call', { name: 'slow', arguments: {} }), { session: 'A' })
    await wait(10)
    await server.handleMessage(rpc(null, 'notifications/cancelled', { requestId: 1 }), { session: 'B' })
    const res = (await a) as { result: { content: { text: string }[] } }
    expect(res.result.content[0]!.text).toBe('done')
  })

  it('a cancel from the same session still aborts', async () => {
    const server = new McpServer({ tools: [slow()] })
    const session = {}
    const a = server.handleMessage(rpc(1, 'tools/call', { name: 'slow', arguments: {} }), { session })
    await wait(10)
    await server.handleMessage(rpc(null, 'notifications/cancelled', { requestId: 1 }), { session })
    const res = (await a) as { result: { content: { text: string }[] } }
    expect(res.result.content[0]!.text).toBe('aborted')
  })

  it('rejects a second in-flight request reusing an id in the same session', async () => {
    const server = new McpServer({ tools: [slow(50)] })
    const first = server.handleMessage(rpc(1, 'tools/call', { name: 'slow', arguments: {} }), { session: 's' })
    const dup = await server.handleMessage(rpc(1, 'tools/call', { name: 'slow', arguments: {} }), { session: 's' })
    expect(dup?.error?.code).toBe(-32600)
    expect(((await first) as { result: { content: { text: string }[] } }).result.content[0]!.text).toBe('done')
  })

  it('a request WITHOUT id (notification form) is neither executed nor answered', async () => {
    let ran = 0
    const server = new McpServer({
      tools: [{ name: 't', description: '', inputSchema: { type: 'object' }, invoke: async () => { ran++; return { content: [{ type: 'text', text: 'x' }] } } }],
    })
    const res = await server.handleMessage(rpc(null, 'tools/call', { name: 't', arguments: {} }))
    expect(res).toBeNull()
    expect(ran).toBe(0)
  })

  it('a JSON-RPC response sent to the server is ignored, not answered with an error', async () => {
    const server = new McpServer()
    expect(await server.handleMessage({ jsonrpc: '2.0', id: 9, result: {} } as never)).toBeNull()
  })

  it('two stdio streams on one server are separate sessions', async () => {
    const server = new McpServer({ tools: [slow()] })
    const inA = new PassThrough()
    const inB = new PassThrough()
    const outA: string[] = []
    const hA = serveStdio(server, { input: inA, output: { write: (c: string) => outA.push(c) } })
    const hB = serveStdio(server, { input: inB, output: { write: () => true } })
    inA.write(`${JSON.stringify(rpc(1, 'tools/call', { name: 'slow', arguments: {} }))}\n`)
    await wait(10)
    inB.write(`${JSON.stringify(rpc(null, 'notifications/cancelled', { requestId: 1 }))}\n`)
    await wait(400)
    hA.close()
    hB.close()
    expect(JSON.parse(outA[0]!).result.content[0].text).toBe('done')
  })
})

// FA-039 — serveHttp body cap and non-loopback bind.
describe('serveHttp — body cap and bind policy', () => {
  const echo: McpToolDef = { name: 'echo', description: '', inputSchema: { type: 'object' }, invoke: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }
  const send = (port: number, headers: Record<string, string>, body: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
        (res) => {
          let b = ''
          res.on('data', (c) => { b += c })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
        },
      )
      req.on('error', reject)
      req.end(body)
    })

  it('answers 413 for a body over maxBodyBytes (declared length) without dispatching', async () => {
    const h = await serveHttp(new McpServer({ tools: [echo] }), { port: 0 })
    try {
      const big = await send(h.port, {}, 'x'.repeat(2 * 1024 * 1024))
      expect(big.status).toBe(413)
      expect((await send(h.port, {}, JSON.stringify(rpc(1, 'ping')))).status).toBe(200)
    } finally {
      await h.close()
    }
  })

  it('answers 413 for a chunked body that grows past the cap', async () => {
    const h = await serveHttp(new McpServer({ tools: [echo] }), { port: 0, maxBodyBytes: 1024 })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: h.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
          (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) },
        )
        req.on('error', reject)
        req.write('x'.repeat(800))
        req.end('y'.repeat(800))
      })
      expect(status).toBe(413)
    } finally {
      await h.close()
    }
  })

  it('refuses a non-loopback bind without authorize/allowRequest', async () => {
    await expect(serveHttp(new McpServer(), { host: '0.0.0.0', port: 0 })).rejects.toThrow(/non-loopback/)
  })

  it('authorize gates every request (401) and receives the raw request', async () => {
    const h = await serveHttp(new McpServer({ tools: [echo] }), {
      port: 0,
      authorize: (req) => req.headers.authorization === 'Bearer s3cret',
    })
    try {
      expect((await send(h.port, {}, JSON.stringify(rpc(1, 'ping')))).status).toBe(401)
      expect((await send(h.port, { authorization: 'Bearer s3cret' }, JSON.stringify(rpc(1, 'ping')))).status).toBe(200)
    } finally {
      await h.close()
    }
  })

  it('forwards the peer address to tools and accepts a batch', async () => {
    let seen: string | undefined
    const who: McpToolDef = { name: 'who', description: '', inputSchema: { type: 'object' }, invoke: async (_a, c) => { seen = c.remoteAddress; return { content: [{ type: 'text', text: 'x' }] } } }
    const h = await serveHttp(new McpServer({ tools: [who] }), { port: 0 })
    try {
      const res = await send(h.port, {}, JSON.stringify([rpc(1, 'ping'), rpc(2, 'tools/call', { name: 'who', arguments: {} }), rpc(null, 'notifications/initialized')]))
      const body = JSON.parse(res.body) as { id: number }[]
      expect(body.map((m) => m.id).sort()).toEqual([1, 2])
      expect(seen).toMatch(/127\.0\.0\.1/)
    } finally {
      await h.close()
    }
  })
})

// FA-040 — stdio elicitation, batch, UTF-8, line cap.
describe('serveStdio — elicitation, batches, UTF-8 and line cap', () => {
  const start = (tools: McpToolDef[], opts: { maxLineLength?: number } = {}) => {
    const input = new PassThrough()
    const lines: string[] = []
    const handle = serveStdio(new McpServer({ tools }), { input, output: { write: (c: string) => { lines.push(c) } }, ...opts })
    const msgs = () => lines.map((l) => JSON.parse(l) as Record<string, any>)
    return { input, msgs, handle }
  }
  const asker: McpToolDef = {
    name: 'ask',
    description: '',
    inputSchema: { type: 'object' },
    invoke: async (_a, c) => ({ content: [{ type: 'text', text: c.elicit ? String(await c.elicit('Proceed?')) : 'no-elicit' }] }),
  }
  const init = (caps: Record<string, unknown>) => `${JSON.stringify(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: caps, clientInfo: { name: 'x', version: '1' } }))}\n`

  it('wires elicit when the client announced the capability: accept + confirm:true → true', async () => {
    const { input, msgs, handle } = start([asker])
    input.write(init({ elicitation: {} }))
    input.write(`${JSON.stringify(rpc(2, 'tools/call', { name: 'ask', arguments: {} }))}\n`)
    await wait()
    const req = msgs().find((m) => m['method'] === 'elicitation/create')!
    expect(req['params'].message).toBe('Proceed?')
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: req['id'], result: { action: 'accept', content: { confirm: true } } })}\n`)
    await wait()
    handle.close()
    expect(msgs().find((m) => m['id'] === 2)!['result'].content[0].text).toBe('true')
    // The client's response is never answered.
    expect(msgs().filter((m) => m['error'])).toHaveLength(0)
  })

  it('a declined elicitation → false', async () => {
    const { input, msgs, handle } = start([asker])
    input.write(init({ elicitation: {} }))
    input.write(`${JSON.stringify(rpc(2, 'tools/call', { name: 'ask', arguments: {} }))}\n`)
    await wait()
    const req = msgs().find((m) => m['method'] === 'elicitation/create')!
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: req['id'], result: { action: 'decline' } })}\n`)
    await wait()
    handle.close()
    expect(msgs().find((m) => m['id'] === 2)!['result'].content[0].text).toBe('false')
  })

  it('no elicit without the client capability', async () => {
    const { input, msgs, handle } = start([asker])
    input.write(init({}))
    input.write(`${JSON.stringify(rpc(2, 'tools/call', { name: 'ask', arguments: {} }))}\n`)
    await wait()
    handle.close()
    expect(msgs().find((m) => m['id'] === 2)!['result'].content[0].text).toBe('no-elicit')
  })

  it('answers a JSON-RPC batch with an array of responses', async () => {
    const { input, msgs, handle } = start([])
    input.write('[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]\n')
    await wait()
    handle.close()
    const out = msgs()
    expect(out).toHaveLength(1)
    expect(Array.isArray(out[0])).toBe(true)
    expect((out[0] as unknown as { id: number }[]).map((m) => m.id).sort()).toEqual([1, 2])
  })

  it('an empty batch is an invalid request; initialize inside a batch is rejected', async () => {
    const server = new McpServer()
    expect(await dispatchPayload(server, [])).toMatchObject({ id: null, error: { code: -32600 } })
    const res = (await dispatchPayload(server, [rpc(1, 'initialize', {})])) as { error?: { code: number } }[]
    expect(res[0]!.error?.code).toBe(-32600)
  })

  it('reassembles a multibyte character split across two chunks', async () => {
    const echo: McpToolDef = { name: 'echo', description: '', inputSchema: { type: 'object' }, invoke: async (a) => ({ content: [{ type: 'text', text: String(a['text']) }] }) }
    const { input, msgs, handle } = start([echo])
    const b = Buffer.from(`${JSON.stringify(rpc(1, 'tools/call', { name: 'echo', arguments: { text: 'é' } }))}\n`)
    const k = b.indexOf(Buffer.from('é')) + 1
    input.write(b.subarray(0, k))
    await wait()
    input.write(b.subarray(k))
    await wait()
    handle.close()
    expect(msgs().find((m) => m['id'] === 1)!['result'].content[0].text).toBe('é')
  })

  it('drops an over-long line with an error and keeps serving', async () => {
    const { input, msgs, handle } = start([], { maxLineLength: 64 })
    input.write('x'.repeat(50))
    input.write('x'.repeat(50)) // over the cap before any newline: discarded
    input.write('tail\n')
    input.write(`${JSON.stringify(rpc(7, 'ping'))}\n`)
    await wait()
    handle.close()
    const out = msgs()
    expect(out[0]).toMatchObject({ id: null, error: { code: -32600 } })
    expect(out.find((m) => m['id'] === 7)!['result']).toEqual({})
    expect(out).toHaveLength(2)
  })
})
