import { describe, expect, it } from 'vitest'
import {
  createPlan,
  detectProject,
  memoryReader,
  parsePlan,
  type AIProvider,
  type GenerateOptions,
} from '../src/index.js'

/** A provider that returns canned JSON and records the prompt it received. */
function fakeProvider(response: string): AIProvider & { lastPrompt: string } {
  const state = { lastPrompt: '' }
  return {
    name: 'fake',
    model: 'fake-1',
    async generate(options: GenerateOptions) {
      state.lastPrompt = options.messages.map((m) => `${m.role}:${m.content}`).join('\n')
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

const PLAN_JSON = JSON.stringify({
  summary: 'Add a tenant-scoped Patient resource via the generator.',
  entities: [
    {
      name: 'Patient',
      fields: [{ name: 'name', type: 'String' }, { name: 'birthDate', type: 'DateTime' }],
      tenantScoped: true,
      relations: ['Appointment'],
    },
  ],
  steps: [
    { order: 1, title: 'Scaffold Patient', kind: 'generator', detail: 'full vertical', command: 'basalt make:resource Patient --prisma --soft-delete', files: ['src/modules/patient'] },
    { order: 2, title: 'Register permissions', kind: 'permissions', detail: 'RBAC' },
  ],
  permissions: ['patients.view', 'patients.create', 'patients.update', 'patients.delete'],
  auditEvents: ['patient.created', 'patient.updated', 'patient.deleted'],
  tenantScoped: true,
  warnings: ['Confirm which roles may create patients.'],
})

const files = {
  'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1.0.0' } }),
  'src/app.ts': "createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })",
  'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
}

describe('createPlan', () => {
  it('parses a well-formed plan and grounds the prompt in the project', async () => {
    const provider = fakeProvider(PLAN_JSON)
    const ctx = detectProject('/proj', memoryReader(files))
    const plan = await createPlan(provider, ctx, 'Adicionar um módulo de pacientes')

    expect(plan.request).toBe('Adicionar um módulo de pacientes')
    expect(plan.entities[0]?.name).toBe('Patient')
    expect(plan.entities[0]?.tenantScoped).toBe(true)
    expect(plan.steps[0]?.command).toContain('make:resource Patient')
    expect(plan.permissions).toContain('patients.create')
    expect(plan.auditEvents).toContain('patient.created')

    // Context Engineering: the prompt carries stack + generator info, not the whole repo.
    expect(provider.lastPrompt).toContain('tenancy: ENABLED')
    expect(provider.lastPrompt).toContain('make:resource')
    expect(provider.lastPrompt).toContain('Adicionar um módulo de pacientes')
  })
})

describe('parsePlan', () => {
  it('strips markdown fences before parsing', () => {
    const plan = parsePlan('```json\n' + PLAN_JSON + '\n```', 'req')
    expect(plan.entities[0]?.name).toBe('Patient')
  })

  it('tolerates missing arrays', () => {
    const plan = parsePlan('{"summary":"x"}', 'req')
    expect(plan.steps).toEqual([])
    expect(plan.permissions).toEqual([])
    expect(plan.tenantScoped).toBe(false)
  })

  it('throws a clear error on non-JSON', () => {
    expect(() => parsePlan('I cannot help with that', 'req')).toThrow(/did not return valid JSON/)
  })

  it('defaults an unknown step kind to "other" and sorts by order', () => {
    const plan = parsePlan(
      '{"steps":[{"order":2,"title":"b","kind":"wat"},{"order":1,"title":"a","kind":"schema"}]}',
      'req',
    )
    expect(plan.steps.map((s) => s.title)).toEqual(['a', 'b'])
    expect(plan.steps[0]?.kind).toBe('schema')
    expect(plan.steps[1]?.kind).toBe('other')
  })
})
