import { describe, expect, it } from 'vitest'
import {
  buildReviewContext,
  detectProject,
  memoryReader,
  parseReview,
  reviewImplementation,
  runMake,
  type AIProvider,
  type ArchitecturePlan,
  type GenerateOptions,
} from '../src/index.js'

function fakeProvider(response: string): AIProvider & { lastPrompt: string } {
  const state = { lastPrompt: '' }
  return {
    name: 'fake',
    model: 'fake-1',
    async generate(options: GenerateOptions) {
      state.lastPrompt = options.messages.map((m) => m.content).join('\n')
      return response
    },
    async *stream(options: GenerateOptions) {
      yield await this.generate(options)
    },
    get lastPrompt() {
      return state.lastPrompt
    },
  }
}

describe('parseReview', () => {
  it('derives approved=true from an empty issues list', () => {
    const r = parseReview('{"summary":"looks good","issues":[]}')
    expect(r.approved).toBe(true)
    expect(r.summary).toBe('looks good')
  })

  it('derives approved=false when any issue is error-severity (ignores a stray approved flag)', () => {
    const r = parseReview(
      '{"approved":true,"summary":"x","issues":[{"dimension":"tenancy","severity":"error","message":"leaks across tenants"}]}',
    )
    expect(r.approved).toBe(false)
    expect(r.issues[0]?.dimension).toBe('tenancy')
  })

  it('warnings do not block approval', () => {
    const r = parseReview('{"issues":[{"dimension":"audit","severity":"warning","message":"no audit"}]}')
    expect(r.approved).toBe(true)
  })

  it('strips markdown fences', () => {
    const r = parseReview('```json\n{"issues":[]}\n```')
    expect(r.approved).toBe(true)
  })

  it('throws on non-JSON', () => {
    expect(() => parseReview('I approve this')).toThrow(/did not return valid JSON/)
  })
})

describe('reviewImplementation', () => {
  const ctx = detectProject(
    '/p',
    memoryReader({
      'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }),
      'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
      'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
    }),
  )
  const plan: ArchitecturePlan = {
    request: 'add a clientes module',
    summary: 'Cliente',
    entities: [{ name: 'Cliente', tenantScoped: true, fields: [{ name: 'nome', type: 'String' }] }],
    steps: [{ order: 1, title: 'x', kind: 'generator', detail: '', command: 'basalt make:resource Cliente --prisma' }],
    permissions: [],
    auditEvents: [],
    tenantScoped: true,
    warnings: [],
  }

  it('sends the generated code to the reviewer and returns its verdict', async () => {
    const result = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })
    const provider = fakeProvider('{"summary":"tenant scoping present","issues":[]}')
    const verdict = await reviewImplementation(provider, plan, result)

    expect(verdict.approved).toBe(true)
    // the prompt carries the real generated code + deterministic review
    expect(provider.lastPrompt).toContain('GENERATED CODE:')
    expect(provider.lastPrompt).toContain('currentTenantId') // from the generated repository
    expect(provider.lastPrompt).toContain('DETERMINISTIC REVIEW:')
  })

  it('buildReviewContext includes the request and the model file', async () => {
    const result = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })
    const context = buildReviewContext(plan, result)
    expect(context).toContain('REQUEST: add a clientes module')
    expect(context).toMatch(/cliente\.prisma ---/)
    expect(context).toMatch(/model Cliente \{/)
  })
})
