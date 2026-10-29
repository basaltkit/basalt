import { describe, expect, it } from 'vitest'
import { detectProject, memoryReader, runMake, withGeneratorEntities, type ArchitecturePlan } from '../src/index.js'

const schema = `datasource db { provider = "postgresql" url = env("DATABASE_URL") }
enum EmailStatus { queued sent }
model EmailTemplate {
  id       String  @id @default(cuid())
  tenantId String
  slug     String
  body     String?
  emails   Email[]
}
model Email {
  id         String        @id @default(cuid())
  tenantId   String
  to         String
  status     EmailStatus
  retryCount Int
  sentAt     DateTime?
  template   EmailTemplate @relation(fields: [templateId], references: [id])
  templateId String
}`

const ctx = detectProject(
  '/proj',
  memoryReader({
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^4.0.0', '@basaltkit/tenancy': '^4.0.0' } }),
    'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
    'prisma/schema.prisma': schema,
  }),
)

// What a model returned for "crie um modulo de email" on an app whose Email
// models already existed: generator steps, no entities.
const plan: ArchitecturePlan = {
  request: 'crie um modulo de email',
  summary: 'CRUD for the existing email models',
  entities: [],
  steps: [
    { order: 1, title: 'Email', kind: 'generator', detail: '', command: 'basalt make:resource Email --prisma' },
    { order: 2, title: 'Template', kind: 'generator', detail: '', command: 'basalt make:resource EmailTemplate --prisma --soft-delete' },
    { order: 3, title: 'Unknown', kind: 'generator', detail: '', command: 'basalt make:resource Bounce' },
  ],
  permissions: [],
  auditEvents: [],
  tenantScoped: true,
  warnings: [],
}

describe('withGeneratorEntities', () => {
  it('reads column types from the existing model', () => {
    const email = ctx.prisma?.models.find((m) => m.name === 'Email')
    expect(email?.columns?.find((c) => c.name === 'sentAt')).toEqual({ name: 'sentAt', type: 'DateTime', optional: true, list: false })
    expect(email?.columns?.find((c) => c.name === 'template')?.type).toBe('EmailTemplate')
  })

  it('adds an entity per generator step, fields from the existing model', () => {
    const entities = withGeneratorEntities(plan, ctx).entities
    expect(entities.map((e) => e.name)).toEqual(['Email', 'EmailTemplate', 'Bounce'])
    const email = entities[0]!
    expect(email.tenantScoped).toBe(true)
    // Scalars kept (enum → String); the relation field and list are left to the schema.
    expect(email.fields).toEqual([
      { name: 'id', type: 'String' },
      { name: 'tenantId', type: 'String' },
      { name: 'to', type: 'String' },
      { name: 'status', type: 'String' },
      { name: 'retryCount', type: 'Int' },
      { name: 'sentAt', type: 'DateTime' },
      { name: 'templateId', type: 'String' },
    ])
    expect(entities[1]!.fields.map((f) => f.name)).toEqual(['id', 'tenantId', 'slug', 'body'])
    expect(entities[2]).toEqual({ name: 'Bounce', fields: [], tenantScoped: true })
  })

  it('leaves a plan alone when every generator step has its entity', () => {
    const complete = { ...plan, steps: [plan.steps[0]!], entities: [{ name: 'email', fields: [], tenantScoped: true }] }
    expect(withGeneratorEntities(complete, ctx)).toBe(complete)
  })
})

describe('ai:make on a generator-only plan', () => {
  it('scaffolds every generator step instead of "nothing to generate"', async () => {
    const result = await runMake(ctx, plan, { dryRun: true, baseDir: '/proj' })
    expect(result.resources.map((r) => [r.name, r.prisma, r.softDelete])).toEqual([
      ['Email', true, false],
      ['EmailTemplate', true, true],
      ['Bounce', false, false],
    ])
    const schemaFile = result.resources[0]!.files.find((f) => f.path.endsWith('email.schema.ts'))!
    expect(schemaFile.content).toContain('retryCount: z.number().int()')
  })
})
