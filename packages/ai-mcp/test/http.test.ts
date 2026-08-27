import { memoryReader } from '@basaltkit/ai/analysis'
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
