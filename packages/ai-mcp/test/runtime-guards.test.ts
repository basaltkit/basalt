import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memoryReader } from '@basaltkit/ai/analysis'
import {
  AiMcpProductionError,
  assertDevOnly,
  buildAiMcpServer,
  createAiMcpHttpServer,
  createSession,
  resolveWorkspaceRoot,
  WorkspaceEscapeError,
} from '../src/index.js'
import { PROJECT_FILES } from './fixture.js'

describe('dev-only runtime guard (audit item 8)', () => {
  it('refuses to build the server when NODE_ENV=production', () => {
    expect(() => buildAiMcpServer({ cwd: '/proj', env: { NODE_ENV: 'production' } })).toThrow(AiMcpProductionError)
    expect(() => assertDevOnly({ NODE_ENV: ' Production ' })).toThrow(AiMcpProductionError)
  })

  it('the HTTP entry rejects (so the bin reports it) instead of binding a port', async () => {
    await expect(createAiMcpHttpServer({ cwd: '/proj', env: { NODE_ENV: 'production' }, port: 0 })).rejects.toBeInstanceOf(
      AiMcpProductionError,
    )
  })

  it('an explicit override lets it start', () => {
    expect(() => buildAiMcpServer({ cwd: '/proj', env: { NODE_ENV: 'production' }, allowProduction: true })).not.toThrow()
    expect(() =>
      buildAiMcpServer({ cwd: '/proj', env: { NODE_ENV: 'production', BASALT_AI_MCP_ALLOW_PRODUCTION: '1' } }),
    ).not.toThrow()
  })

  it('starts in development, test, and with no NODE_ENV (how MCP clients launch the bin)', () => {
    for (const env of [{}, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }]) {
      expect(() => buildAiMcpServer({ cwd: '/proj', env })).not.toThrow()
    }
  })
})

describe('workspaceRoot is confined to the project root (audit item 8)', () => {
  let outside: string
  let project: string

  beforeAll(() => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ai-mcp-confine-')))
    project = join(base, 'project')
    outside = join(base, 'secret')
    mkdirSync(join(project, 'packages', 'api'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'package.json'), '{}')
    // A symlink inside the project that points outside it.
    symlinkSync(outside, join(project, 'escape'), 'dir')
  })
  afterAll(() => rmSync(join(project, '..'), { recursive: true, force: true }))

  const session = () => createSession({ cwd: project })

  it('accepts the project root and paths inside it (absolute or relative)', () => {
    expect(resolveWorkspaceRoot(session(), undefined)).toBe(project)
    expect(resolveWorkspaceRoot(session(), join(project, 'packages', 'api'))).toBe(join(project, 'packages', 'api'))
    expect(resolveWorkspaceRoot(session(), 'packages/api')).toBe(join(project, 'packages', 'api'))
  })

  it('refuses absolute paths outside, parent traversal, and symlinks that resolve outside', () => {
    expect(() => resolveWorkspaceRoot(session(), outside)).toThrow(WorkspaceEscapeError)
    expect(() => resolveWorkspaceRoot(session(), '/')).toThrow(WorkspaceEscapeError)
    expect(() => resolveWorkspaceRoot(session(), '../secret')).toThrow(WorkspaceEscapeError)
    expect(() => resolveWorkspaceRoot(session(), join(project, 'escape'))).toThrow(WorkspaceEscapeError)
    expect(() => resolveWorkspaceRoot(session(), 'escape/nested')).toThrow(WorkspaceEscapeError)
  })

  it.each(['basalt_analyze', 'basalt_doctor'])('%s returns a refusal instead of reading outside', async (name) => {
    const server = buildAiMcpServer({ cwd: project, createReader: () => memoryReader(PROJECT_FILES) })
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { workspaceRoot: outside } },
    })
    const result = res?.result as { isError?: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/^Refused: .*outside the project root/)
  })

  it('basalt_plan refuses too (before calling the provider)', async () => {
    let providerCalls = 0
    const server = buildAiMcpServer({
      cwd: project,
      createReader: () => memoryReader(PROJECT_FILES),
      createProvider: () => {
        providerCalls++
        return { name: 'mock', generate: async () => ({ text: '{}' }) } as never
      },
    })
    const res = await server.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'basalt_plan', arguments: { request: 'add invoices', workspaceRoot: outside } },
    })
    expect((res?.result as { isError?: boolean }).isError).toBe(true)
    expect(providerCalls).toBe(0)
  })
})
