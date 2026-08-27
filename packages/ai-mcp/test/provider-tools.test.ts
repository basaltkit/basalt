import { PassThrough } from 'node:stream'
import { memoryReader } from '@basaltkit/ai/analysis'
import type { AIProvider, GenerateOptions } from '@basaltkit/ai/workflows'
import { describe, expect, it } from 'vitest'
import { buildAiMcpServer, createAiMcpServer } from '../src/index.js'
import { PROJECT_FILES, fixtureServer } from './fixture.js'

const tick = () => new Promise((r) => setImmediate(r))
const flush = async () => {
  await tick()
  await tick()
  await tick()
}

/** A mock provider whose stream yields the given chunks (honouring the abort signal). No network. */
function mockProvider(chunks: string[]): AIProvider {
  return {
    name: 'mock',
    model: 'mock-1',
    async generate() {
      return chunks.join('')
    },
    async *stream(options: GenerateOptions) {
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        yield chunk
      }
    },
  }
}

/** A provider that never completes — for cancellation tests. */
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

const PLAN =
  '{"summary":"Add a Patient resource","entities":[{"name":"Patient","fields":[{"name":"name","type":"String"}],"tenantScoped":true}],"permissions":[],"auditEvents":[]}'
const PLAN_CHUNKS = [PLAN.slice(0, 30), PLAN.slice(30, 70), PLAN.slice(70)]

const SAMPLE_PLAN = {
  schemaVersion: 1,
  request: 'r',
  summary: 's',
  entities: [{ name: 'Patient', fields: [], tenantScoped: true }],
  steps: [],
  permissions: [],
  auditEvents: [],
  tenantScoped: true,
  warnings: [],
}
const SAMPLE_MAKE_RESULT = {
  schemaVersion: 1,
  request: 'r',
  dryRun: true,
  resources: [],
  followUps: [],
  review: { items: [], ok: true },
}

describe('basalt_plan (mock provider)', () => {
  it('returns an ArchitecturePlan with schemaVersion and emits progress', async () => {
    const progress: Array<{ method?: string }> = []
    const server = fixtureServer({ createProvider: () => mockProvider(PLAN_CHUNKS) })
    const res = await server.handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'basalt_plan', arguments: { request: 'add a patient module' }, _meta: { progressToken: 'p1' } },
      },
      { notify: (m) => progress.push(m) },
    )
    const result = res?.result as { structuredContent: { entities: Array<{ name: string }>; schemaVersion: number } }
    expect(result.structuredContent.entities[0]!.name).toBe('Patient')
    expect(result.structuredContent.schemaVersion).toBe(1)
    expect(progress.filter((m) => m.method === 'notifications/progress').length).toBeGreaterThan(0)
  })

  it('errors (isError) with provider guidance when no provider is configured — never leaking keys', async () => {
    const server = buildAiMcpServer({ cwd: '/proj', createReader: () => memoryReader(PROJECT_FILES), env: {} })
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'basalt_plan', arguments: { request: 'x' } },
    })
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/AI provider/i)
  })

  it('rejects an empty request', async () => {
    const server = fixtureServer({ createProvider: () => mockProvider(PLAN_CHUNKS) })
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'basalt_plan', arguments: { request: '   ' } },
    })
    expect((res?.result as { isError?: boolean }).isError).toBe(true)
  })

  it('stops promptly when cancelled mid-run', async () => {
    const server = fixtureServer({ createProvider: () => hangingProvider() })
    const pending = server.handleMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'basalt_plan', arguments: { request: 'x' } },
    })
    await tick()
    await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } })
    const res = await pending
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/cancel/i)
  })
})

describe('basalt_review (mock provider)', () => {
  it('returns a verdict as structuredContent', async () => {
    const server = fixtureServer({ createProvider: () => mockProvider(['{"summary":"ok",', '"issues":[]}']) })
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'basalt_review', arguments: { plan: SAMPLE_PLAN, makeResult: SAMPLE_MAKE_RESULT } },
    })
    const result = res?.result as { structuredContent: { approved: boolean } }
    expect(result.structuredContent.approved).toBe(true)
  })
})

describe('basalt_plan over stdio (progress on the wire)', () => {
  it('emits notifications/progress and the final plan result', async () => {
    const input = new PassThrough()
    const lines: Array<Record<string, any>> = []
    const output = {
      write(chunk: string) {
        for (const line of chunk.split('\n')) if (line.trim()) lines.push(JSON.parse(line))
        return true
      },
    }
    const handle = createAiMcpServer({
      cwd: '/proj',
      createReader: () => memoryReader(PROJECT_FILES),
      createProvider: () => mockProvider(PLAN_CHUNKS),
      input,
      output,
    })
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'basalt_plan', arguments: { request: 'x' }, _meta: { progressToken: 't' } } })}\n`,
    )
    await flush()

    expect(lines.filter((l) => l.method === 'notifications/progress').length).toBeGreaterThan(0)
    const result = lines.find((l) => l.id === 1)!
    expect(result.result.structuredContent.entities[0].name).toBe('Patient')
    handle.close()
  })
})
