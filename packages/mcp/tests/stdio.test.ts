import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import {
  serveMcpStdio,
  McpClient,
  McpClients,
  StdioClientTransport,
  buildStdioEnv,
  type McpServerConnection,
  type StdioTransportOptions,
} from '../src/index.js'
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
    expect((lines[1] as { result: { tools: unknown[] } }).result.tools).toHaveLength(4)
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

// A stdio server whose only tool reports the environment it was spawned with.
const ENV_SERVER = `
process.stdin.setEncoding('utf8'); let buf='';
process.stdin.on('data', d => { buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0,i).trim(); buf = buf.slice(i+1);
    if (!l) continue; const m = JSON.parse(l); if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'env', version: '1' } };
    else if (m.method === 'tools/call') result = { content: [], structuredContent: { ...process.env } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`

describe('StdioClientTransport environment isolation (secrets must not leak to spawned servers)', () => {
  const SECRETS = {
    APP_SECRET: 'host-app-jwt-secret-xyz',
    // Built at runtime so secret scanners do not flag a fake credential in a test fixture.
    DATABASE_URL: ['postgresql://user', 'pw@db/app'].join(':'),
    OPENAI_API_KEY: 'sk-host-provider-key',
  }

  async function spawnedEnv(options: Partial<StdioTransportOptions> = {}, connection?: McpServerConnection) {
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(SECRETS)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }
    try {
      if (connection) {
        const clients = new McpClients({ env: connection })
        try {
          const result = await clients.callTool('env', 'dump', {})
          return result.structuredContent as Record<string, string>
        } finally {
          await clients.closeAll()
        }
      }
      const client = new McpClient(
        new StdioClientTransport({ command: process.execPath, args: ['-e', ENV_SERVER], ...options }),
      )
      try {
        await client.connect()
        const result = await client.callTool('dump', {})
        return result.structuredContent as Record<string, string>
      } finally {
        await client.close()
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it('does not pass host secrets to the child by default, but keeps PATH and explicit env', async () => {
    const env = await spawnedEnv({ env: { SERVER_TOKEN: 'scoped' } })
    expect(env.APP_SECRET).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.SERVER_TOKEN).toBe('scoped')
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH)
  })

  it('does not leak host secrets through the McpClients stdio connection either', async () => {
    const env = await spawnedEnv({}, { type: 'stdio', command: process.execPath, args: ['-e', ENV_SERVER] })
    expect(env.APP_SECRET).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })

  it('inherits only the named host variables with inheritEnv: string[]', async () => {
    const env = await spawnedEnv({ inheritEnv: ['OPENAI_API_KEY'] })
    expect(env.OPENAI_API_KEY).toBe(SECRETS.OPENAI_API_KEY)
    expect(env.APP_SECRET).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })

  it('inherits the full host environment only with an explicit inheritEnv: true', async () => {
    const env = await spawnedEnv(
      {},
      { type: 'stdio', command: process.execPath, args: ['-e', ENV_SERVER], inheritEnv: true },
    )
    expect(env.APP_SECRET).toBe(SECRETS.APP_SECRET)
  })
})

describe('buildStdioEnv (host secrets are not inherited unless named)', () => {
  const host = {
    PATH: '/bin',
    Path: '/win/bin',
    SystemRoot: 'C:\\Windows',
    APP_SECRET: 's',
    app_secret: 's2',
    DATABASE_URL: 'pg://x',
    AWS_SECRET_ACCESS_KEY: 'aws',
  }

  it('keeps only allowlisted keys, matching Windows casing, by default and with inheritEnv: false', () => {
    for (const inheritEnv of [undefined, false] as const) {
      const env = buildStdioEnv(inheritEnv === undefined ? {} : { inheritEnv }, host)
      expect(env).toEqual({ PATH: '/bin', Path: '/win/bin', SystemRoot: 'C:\\Windows' })
    }
  })

  it('lets explicit env win and add variables without widening inheritance', () => {
    const env = buildStdioEnv({ env: { PATH: '/custom', TOKEN: 't' }, inheritEnv: ['aws_secret_access_key'] }, host)
    expect(env).toEqual({ PATH: '/custom', Path: '/win/bin', SystemRoot: 'C:\\Windows', AWS_SECRET_ACCESS_KEY: 'aws', TOKEN: 't' })
  })
})
