import { describe, expect, it } from 'vitest'
import { fixtureServer } from './fixture.js'

const read = (uri: string) =>
  fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } })

describe('project + knowledge resources', () => {
  it('lists all four resources', async () => {
    const res = await fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'resources/list' })
    const uris = (res?.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri).sort()
    expect(uris).toEqual([
      'basalt://knowledge/architecture',
      'basalt://project/analysis',
      'basalt://project/context',
      'basalt://project/diagnostics',
    ])
  })

  it('reads basalt://project/context as the detected ProjectContext', async () => {
    const res = await read('basalt://project/context')
    const contents = (res?.result as { contents: Array<{ uri: string; mimeType: string; text: string }> }).contents[0]!
    expect(contents.uri).toBe('basalt://project/context')
    expect(contents.mimeType).toBe('application/json')
    const ctx = JSON.parse(contents.text)
    expect(ctx.stack.orm).toBe('prisma')
    expect(ctx.stack.http).toBe('fastify')
  })

  it('reads basalt://project/analysis as the AnalysisReport', async () => {
    const res = await read('basalt://project/analysis')
    const report = JSON.parse((res?.result as { contents: Array<{ text: string }> }).contents[0]!.text)
    expect(report.models).toEqual(['Tenant'])
  })

  it('reads basalt://project/diagnostics as the doctor findings', async () => {
    const res = await read('basalt://project/diagnostics')
    const diags = JSON.parse((res?.result as { contents: Array<{ text: string }> }).contents[0]!.text)
    expect(Array.isArray(diags)).toBe(true)
    expect(diags.length).toBeGreaterThan(0)
  })

  it('reads basalt://knowledge/architecture as the framework knowledge', async () => {
    const res = await read('basalt://knowledge/architecture')
    const contents = (res?.result as { contents: Array<{ mimeType: string; text: string }> }).contents[0]!
    expect(contents.mimeType).toBe('text/markdown')
    expect(contents.text.length).toBeGreaterThan(100)
  })

  it('fails INVALID_PARAMS for an unknown resource uri', async () => {
    const res = await read('basalt://project/nope')
    expect(res?.error?.code).toBe(-32602)
  })
})
