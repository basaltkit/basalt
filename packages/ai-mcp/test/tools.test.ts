import { describe, expect, it } from 'vitest'
import { fixtureServer } from './fixture.js'

const call = (name: string, args: Record<string, unknown> = {}) =>
  fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })

describe('basalt_analyze', () => {
  it('returns an AnalysisReport as structuredContent (read-only, offline)', async () => {
    const res = await call('basalt_analyze')
    const result = res?.result as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> }
    expect(result.structuredContent['capabilities']).toEqual(
      expect.arrayContaining(['Fastify detected', 'Prisma detected', 'PostgreSQL detected']),
    )
    expect(result.structuredContent['models']).toEqual(['Tenant'])
    expect(result.structuredContent['root']).toBe('/proj')
    // the text content carries the same JSON
    expect(JSON.parse(result.content[0]!.text).root).toBe('/proj')
  })

  it('advertises an outputSchema derived from the AnalysisReport schema', async () => {
    const list = await fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (list?.result as { tools: Array<{ name: string; outputSchema?: { type?: string; properties?: object } }> }).tools
    const analyze = tools.find((t) => t.name === 'basalt_analyze')!
    expect(analyze.outputSchema?.type).toBe('object')
    expect(analyze.outputSchema?.properties).toHaveProperty('diagnostics')
  })

  it('honours a per-call workspaceRoot argument', async () => {
    const res = await call('basalt_analyze', { workspaceRoot: '/elsewhere' })
    // the injected reader ignores the root, but the report echoes it — proving the arg is threaded
    expect((res?.result as { structuredContent: { root: string } }).structuredContent.root).toBe('/elsewhere')
  })
})

describe('basalt_doctor', () => {
  it('returns diagnostics + in-memory fix previews (never writes)', async () => {
    const res = await call('basalt_doctor')
    const report = (res?.result as { structuredContent: {
      diagnostics: Array<{ id: string }>
      hasErrors: boolean
      fixes: Array<{ id: string; status: string; message: string; files: string[] }>
    } }).structuredContent

    expect(report.diagnostics.length).toBeGreaterThan(0)
    expect(report.hasErrors).toBe(true)
    // both auto-fixable rules fire for the fixture — previewed, not applied
    const byId = Object.fromEntries(report.fixes.map((f) => [f.id, f]))
    expect(byId['fastify-logger-off']).toMatchObject({ status: 'ready', files: ['src/app.ts'] })
    expect(byId['insecure-app-secret']).toMatchObject({ status: 'ready', files: ['src/env.ts'] })
  })

  it('advertises an outputSchema with diagnostics + fixes', async () => {
    const list = await fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (list?.result as { tools: Array<{ name: string; outputSchema?: { properties?: Record<string, unknown> } }> }).tools
    const doctor = tools.find((t) => t.name === 'basalt_doctor')!
    expect(doctor.outputSchema?.properties).toHaveProperty('diagnostics')
    expect(doctor.outputSchema?.properties).toHaveProperty('fixes')
  })
})
