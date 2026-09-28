import { memoryReader } from '@basaltkit/ai/analysis'
import type { AIProvider } from '@basaltkit/ai/workflows'
import { describe, expect, it } from 'vitest'
import { createAiMcpHttpServer } from '../src/index.js'
import { PROJECT_FILES } from './fixture.js'

async function rpc(url: string, message: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) })
  return res.json()
}

describe('ai-mcp HTTP transport (opt-in)', () => {
  it('completes initialize -> tools/list over HTTP', async () => {
    const handle = await createAiMcpHttpServer({ cwd: '/proj', createReader: () => memoryReader(PROJECT_FILES), port: 0 })
    try {
      const init = await rpc(handle.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
      expect(init.result.serverInfo).toEqual({ name: 'basalt-ai-mcp', version: '0.1.0' })
      expect(init.result.capabilities.tools).toBeDefined()
      expect(init.result.capabilities.resources).toBeDefined()
      expect(init.result.capabilities.prompts).toBeDefined()

      const list = await rpc(handle.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
      expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        'basalt_analyze', 'basalt_doctor', 'basalt_make', 'basalt_plan', 'basalt_review',
      ])
    } finally {
      await handle.close()
    }
  })
})

describe('ai-mcp HTTP transport — bind policy and bearer token (FA-039)', () => {
  it('refuses a non-loopback bind without a token', async () => {
    await expect(createAiMcpHttpServer({ cwd: '/proj', createReader: () => memoryReader(PROJECT_FILES), host: '0.0.0.0', port: 0 })).rejects.toThrow(/non-loopback/)
  })

  it('with a token, requests need Authorization: Bearer <token>', async () => {
    const handle = await createAiMcpHttpServer({ cwd: '/proj', createReader: () => memoryReader(PROJECT_FILES), port: 0, token: 's3cret' })
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
      const anon = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(anon.status).toBe(401)
      const wrong = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body })
      expect(wrong.status).toBe(401)
      const ok = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer s3cret' }, body })
      expect(ok.status).toBe(200)
    } finally {
      await handle.close()
    }
  })
})

/** A provider that never completes — only a cancellation ends its call. */
function hangingProvider(): AIProvider {
  return {
    name: 'mock',
    model: 'mock-1',
    async generate() {
      return new Promise<string>(() => {})
    },
    async *stream() {
      await new Promise<void>(() => {})
    },
  }
}

async function post(url: string, message: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message) })
  const text = await res.text()
  return { status: res.status, session: res.headers.get('mcp-session-id') ?? undefined, body: text ? JSON.parse(text) : null }
}

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } }

describe('ai-mcp HTTP transport — sessions (opt-in pass-through)', () => {
  it('stays stateless by default: no Mcp-Session-Id issued nor required', async () => {
    const handle = await createAiMcpHttpServer({ cwd: '/proj', createReader: () => memoryReader(PROJECT_FILES), port: 0 })
    try {
      const init = await post(handle.url, INIT)
      expect(init.status).toBe(200)
      expect(init.session).toBeUndefined()
      expect((await post(handle.url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200)
    } finally {
      await handle.close()
    }
  })

  it('sessions: true issues and requires the session, and a separate POST cancels a running tool', async () => {
    const handle = await createAiMcpHttpServer({
      cwd: '/proj',
      createReader: () => memoryReader(PROJECT_FILES),
      createProvider: () => hangingProvider(),
      port: 0,
      sessions: true,
    })
    try {
      const init = await post(handle.url, INIT)
      expect(init.status).toBe(200)
      const session = init.session as string
      expect(session).toMatch(/.+/)
      // Without the header, or with a foreign one: refused.
      expect((await post(handle.url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(400)
      expect((await post(handle.url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { 'mcp-session-id': 'nope' })).status).toBe(404)

      const headers = { 'mcp-session-id': session }
      const pending = post(
        handle.url,
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'basalt_plan', arguments: { request: 'x' } } },
        headers,
      )
      await new Promise((r) => setTimeout(r, 50))
      const cancelled = await post(handle.url, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, headers)
      expect(cancelled.status).toBe(202)
      const res = await pending
      expect(res.body.result.isError).toBe(true)
      expect(res.body.result.content[0].text).toMatch(/cancel/i)
    } finally {
      await handle.close()
    }
  })

  it('passes principal through: a session only serves the caller that opened it', async () => {
    const handle = await createAiMcpHttpServer({
      cwd: '/proj',
      createReader: () => memoryReader(PROJECT_FILES),
      port: 0,
      token: 's3cret',
      sessions: { ttlMs: 60_000 },
      // Two principals behind one token: the header picks which.
      principal: (req) => String(req.headers['x-who'] ?? ''),
    })
    try {
      const auth = { authorization: 'Bearer s3cret' }
      const init = await post(handle.url, INIT, { ...auth, 'x-who': 'alice' })
      const session = init.session as string
      const ping = { jsonrpc: '2.0', id: 1, method: 'ping' }
      expect((await post(handle.url, ping, { ...auth, 'x-who': 'alice', 'mcp-session-id': session })).status).toBe(200)
      expect((await post(handle.url, ping, { ...auth, 'x-who': 'bob', 'mcp-session-id': session })).status).toBe(404)
    } finally {
      await handle.close()
    }
  })
})
