import { describe, expect, it } from 'vitest'
import { fixtureServer } from './fixture.js'

const list = () => fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })
const get = (name: string, args?: Record<string, string>) =>
  fixtureServer().handleMessage({ jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name, ...(args ? { arguments: args } : {}) } })

describe('workflow prompts', () => {
  it('lists all four templates with their arguments', async () => {
    const res = await list()
    const prompts = (res?.result as { prompts: Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }> }).prompts
    expect(prompts.map((p) => p.name).sort()).toEqual(['add-rbac', 'harden-tenancy', 'plan-feature', 'scaffold-resource'])
    const planFeature = prompts.find((p) => p.name === 'plan-feature')!
    expect(planFeature.arguments).toEqual([{ name: 'request', description: expect.any(String), required: true }])
  })

  it('substitutes the request argument into plan-feature and encodes the safe loop', async () => {
    const res = await get('plan-feature', { request: 'a billing module' })
    const result = res?.result as { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> }
    const text = result.messages[0]!.content.text
    expect(result.description).toContain('a billing module')
    expect(text).toContain('a billing module')
    // references the real tools/resources by name, preview before apply
    expect(text).toContain('basalt://project/context')
    expect(text).toContain('basalt_plan')
    expect(text).toContain('mode:"preview"')
    expect(text).toContain('basalt_review')
    expect(text).toContain('mode:"apply"')
    // preview step comes before apply step
    expect(text.indexOf('mode:"preview"')).toBeLessThan(text.indexOf('mode:"apply"'))
  })

  it('substitutes name + optional fields into scaffold-resource', async () => {
    const withFields = await get('scaffold-resource', { name: 'Patient', fields: 'name:String, birthDate:DateTime' })
    const t1 = ((withFields?.result as any).messages[0].content.text) as string
    expect(t1).toContain('"Patient"')
    expect(t1).toContain('name:String, birthDate:DateTime')

    const noFields = await get('scaffold-resource', { name: 'Widget' })
    const t2 = ((noFields?.result as any).messages[0].content.text) as string
    expect(t2).toContain('"Widget"')
    expect(t2).not.toContain('with fields:')
  })

  it('add-rbac substitutes the resource; harden-tenancy needs no arguments', async () => {
    const rbac = ((await get('add-rbac', { resource: 'Invoice' }))?.result as any).messages[0].content.text as string
    expect(rbac).toContain('"Invoice"')
    const harden = ((await get('harden-tenancy'))?.result as any).messages[0].content.text as string
    expect(harden).toContain('basalt://project/diagnostics')
  })

  it('unknown prompt fails with INVALID_PARAMS', async () => {
    const res = await get('nope')
    expect(res?.error?.code).toBe(-32602)
  })
})
