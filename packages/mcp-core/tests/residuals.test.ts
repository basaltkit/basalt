import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { McpServer, McpSessions, RPC_ERRORS, serveHttp, serveStdio, type HttpHandle, type McpToolDef } from '../src/index.js'

const flush = () => new Promise((r) => setImmediate(r))

function collector() {
  const lines: Record<string, unknown>[] = []
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

/** A tool that holds until released (or cancelled) — keeps a request in flight. */
function gate() {
  const releases: (() => void)[] = []
  let started = 0
  const tool: McpToolDef = {
    name: 'hold',
    description: 'Blocks until released',
    inputSchema: { type: 'object' },
    invoke: (_args, ctx) =>
      new Promise((resolve) => {
        started++
        const done = () => resolve({ content: [{ type: 'text', text: 'done' }] })
        releases.push(done)
        ctx.signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true }))
      }),
  }
  return { tool, releases, started: () => started }
}

describe('stdio: per-connection concurrency cap (FA-040 residual)', () => {
  let close: (() => void) | undefined
  afterEach(() => close?.())

  const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'hold', arguments: {} } })

  it('refuses requests past maxConcurrentRequests with SERVER_BUSY, and frees slots as calls finish', async () => {
    const { tool, releases, started } = gate()
    const input = new PassThrough()
    const { lines, output } = collector()
    close = serveStdio(new McpServer({ tools: [tool] }), { input, output, maxConcurrentRequests: 2 }).close
    for (const id of [1, 2, 3]) input.write(`${JSON.stringify(call(id))}\n`)
    await flush()
    expect(started()).toBe(2)
    expect(lines).toEqual([
      { jsonrpc: '2.0', id: 3, error: { code: RPC_ERRORS.SERVER_BUSY, message: expect.stringContaining('max 2') } },
    ])

    // A cancel is a notification: never counted, never refused, even when saturated.
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })}\n`)
    await flush()
    await flush()
    expect(lines.find((l) => l['id'] === 1)).toMatchObject({ result: { isError: true } })

    // The cancelled call freed its slot: a new request is admitted.
    input.write(`${JSON.stringify(call(4))}\n`)
    await flush()
    expect(started()).toBe(3)
    releases.forEach((release) => release())
    await flush()
    await flush()
    expect(lines.filter((l) => 'result' in l).map((l) => l['id']).sort()).toEqual([1, 2, 4])
  })

  it('in a batch, only the requests past the cap are refused (in the same batch reply)', async () => {
    const { tool, releases } = gate()
    const input = new PassThrough()
    const { lines, output } = collector()
    close = serveStdio(new McpServer({ tools: [tool] }), { input, output, maxConcurrentRequests: 1 }).close
    input.write(`${JSON.stringify([call(1), call(2), { jsonrpc: '2.0', method: 'notifications/initialized' }])}\n`)
    await flush()
    releases.forEach((release) => release())
    await flush()
    await flush()
    const batch = lines[0] as unknown as { id: number; error?: { code: number } }[]
    expect(Array.isArray(batch)).toBe(true)
    expect(batch.find((r) => r.id === 1)).toMatchObject({ result: { content: [{ text: 'done' }] } })
    expect(batch.find((r) => r.id === 2)?.error?.code).toBe(RPC_ERRORS.SERVER_BUSY)
  })

  it('defaults to 16 concurrent requests', async () => {
    const { tool, releases, started } = gate()
    const input = new PassThrough()
    const { lines, output } = collector()
    close = serveStdio(new McpServer({ tools: [tool] }), { input, output }).close
    for (let id = 1; id <= 17; id++) input.write(`${JSON.stringify(call(id))}\n`)
    await flush()
    expect(started()).toBe(16)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ id: 17, error: { code: RPC_ERRORS.SERVER_BUSY } })
    releases.forEach((release) => release())
  })
})

describe('serveHttp: Mcp-Session-Id sessions (FA-037 residual)', () => {
  let handle: HttpHandle | undefined
  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })

  const post = async (message: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(handle!.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(message),
    })
    const text = await res.text()
    return { status: res.status, session: res.headers.get('mcp-session-id') ?? undefined, body: text ? JSON.parse(text) : null }
  }
  const init = async (headers: Record<string, string> = {}) => {
    const res = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, headers)
    expect(res.status).toBe(200)
    return res.session as string
  }
  const call = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'hold', arguments: {} } })
  const cancel = (requestId: number) => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } })
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5))
  }

  it('a notifications/cancelled POSTed later in the SAME session cancels the call', async () => {
    const { tool, started } = gate()
    handle = await serveHttp(new McpServer({ tools: [tool] }), { port: 0, sessions: true })
    const session = await init()
    const pending = post(call(7), { 'mcp-session-id': session })
    await waitFor(() => started() === 1)
    const ack = await post(cancel(7), { 'mcp-session-id': session })
    expect(ack.status).toBe(202)
    const result = await pending
    expect(result.body).toMatchObject({ id: 7, result: { isError: true, content: [{ text: 'cancelled' }] } })
  })

  it('another session (even another initialize by the same caller) can never cancel it', async () => {
    const { tool, releases, started } = gate()
    handle = await serveHttp(new McpServer({ tools: [tool] }), { port: 0, sessions: true })
    const mine = await init()
    const theirs = await init()
    expect(theirs).not.toBe(mine)
    const pending = post(call(7), { 'mcp-session-id': mine })
    await waitFor(() => started() === 1)
    expect((await post(cancel(7), { 'mcp-session-id': theirs })).status).toBe(202)
    releases[0]!()
    expect((await pending).body).toMatchObject({ id: 7, result: { content: [{ text: 'done' }] } })
  })

  it('requires the header after initialize (400), and refuses unknown ids (404)', async () => {
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), { port: 0, sessions: true })
    await init()
    const missing = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(missing.status).toBe(400)
    expect(missing.body.error.message).toMatch(/Mcp-Session-Id/)
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'forged' })).status).toBe(404)
  })

  it('binds a session to the principal that opened it (a different bearer gets 404)', async () => {
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), { port: 0, sessions: true })
    const session = await init({ authorization: 'Bearer alice' })
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await post(list, { 'mcp-session-id': session, authorization: 'Bearer alice' })).status).toBe(200)
    expect((await post(list, { 'mcp-session-id': session, authorization: 'Bearer mallory' })).status).toBe(404)
    expect((await post(list, { 'mcp-session-id': session })).status).toBe(404)
  })

  it('a custom principal resolver decides the binding', async () => {
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), {
      port: 0,
      sessions: true,
      principal: (req) => String(req.headers['x-user'] ?? ''),
    })
    const session = await init({ 'x-user': 'alice' })
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    expect((await post(list, { 'mcp-session-id': session, 'x-user': 'alice' })).status).toBe(200)
    expect((await post(list, { 'mcp-session-id': session, 'x-user': 'bob' })).status).toBe(404)
  })

  it('caps how many sessions live at once (least recently used goes first)', async () => {
    // A long TTL so only the cap can end a session — a real-time TTL of a few
    // ms races a slow CI runner.
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), { port: 0, sessions: { ttlMs: 60_000, maxSessions: 2 } })
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const a = await init()
    const b = await init()
    expect((await post(list, { 'mcp-session-id': a })).status).toBe(200) // a is now most recent
    const c = await init() // evicts b
    expect((await post(list, { 'mcp-session-id': b })).status).toBe(404)
    expect((await post(list, { 'mcp-session-id': a })).status).toBe(200)
    expect((await post(list, { 'mcp-session-id': c })).status).toBe(200)
  })

  it('expires an idle session', async () => {
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), { port: 0, sessions: { ttlMs: 40 } })
    const a = await init()
    await new Promise((r) => setTimeout(r, 120))
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': a })).status).toBe(404)
  })

  it('DELETE ends a session; a failed initialize opens none', async () => {
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), { port: 0, sessions: true })
    const session = await init()
    const del = await fetch(handle.url, { method: 'DELETE', headers: { 'mcp-session-id': session } })
    expect(del.status).toBe(204)
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': session })).status).toBe(404)
    expect((await fetch(handle.url, { method: 'DELETE', headers: { 'mcp-session-id': session } })).status).toBe(404)
    const bad = await post({ jsonrpc: '1.0', id: 1, method: 'initialize' })
    expect(bad.body.error.code).toBe(RPC_ERRORS.INVALID_REQUEST)
    expect(bad.session).toBeUndefined()
  })

  it('stateless by default (and with sessions: false) — no header issued nor required', async () => {
    handle = await serveHttp(new McpServer({ tools: [gate().tool] }), { port: 0 })
    const opened = await post({ jsonrpc: '2.0', id: 0, method: 'initialize' })
    expect(opened.session).toBeUndefined()
    expect((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200)
  })
})

describe('McpSessions', () => {
  it('evicts in least-recently-used order and never resolves a foreign principal', () => {
    let now = 0
    const sessions = new McpSessions({ ttlMs: 100, maxSessions: 2 }, () => now)
    const a = sessions.create('p')
    const b = sessions.create('p')
    expect(sessions.resolve(a.id, 'q')).toBeUndefined()
    expect(sessions.resolve(a.id, 'p')).toBe(a)
    sessions.create('p')
    expect(sessions.resolve(b.id, 'p')).toBeUndefined()
    now = 150
    expect(sessions.resolve(a.id, 'p')).toBeUndefined()
    expect(sessions.delete(a.id, 'p')).toBe(false)
  })
})
