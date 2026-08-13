import { describe, expect, it } from 'vitest'
import {
  canonicalType,
  detectProject,
  injectPrismaFields,
  injectZodFields,
  memoryReader,
  runMake,
  zodValidator,
  type ArchitecturePlan,
} from '../src/index.js'

const tenantCtx = detectProject(
  '/proj',
  memoryReader({
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1.0.0' } }),
    'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  }),
)

const plan: ArchitecturePlan = {
  request: 'Add a patient module',
  summary: 'Patient resource',
  entities: [
    {
      name: 'Patient',
      fields: [
        { name: 'name', type: 'String' }, // reserved — must be ignored
        { name: 'birthDate', type: 'DateTime' },
        { name: 'visits', type: 'number' },
      ],
      tenantScoped: true,
    },
  ],
  steps: [
    { order: 1, title: 'Scaffold', kind: 'generator', detail: '', command: 'basalt make:resource Patient --prisma --soft-delete' },
  ],
  permissions: ['patients.create'],
  auditEvents: ['patient.created'],
  tenantScoped: true,
  warnings: [],
}

describe('field mapping', () => {
  it('maps loose types to canonical', () => {
    expect(canonicalType('number')).toBe('Int')
    expect(canonicalType('datetime')).toBe('DateTime')
    expect(canonicalType('bool')).toBe('Boolean')
    expect(canonicalType('whatever')).toBe('String')
  })

  it('produces zod validators, stricter for create', () => {
    expect(zodValidator('String', false)).toBe('z.string()')
    expect(zodValidator('String', true)).toBe('z.string().min(1)')
    expect(zodValidator('Int', false)).toBe('z.number().int()')
    // DateTime: ISO string out, coerced Date in (so Prisma accepts date-only input)
    expect(zodValidator('DateTime', false)).toBe('z.string()')
    expect(zodValidator('DateTime', true)).toBe('z.coerce.date()')
  })
})

describe('injectPrismaFields', () => {
  const model = `model Patient {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`
  it('adds domain fields + tenantId + index, skipping reserved', () => {
    const { content, injected } = injectPrismaFields(
      model,
      [{ name: 'name', type: 'String' }, { name: 'birthDate', type: 'DateTime' }],
      true,
    )
    expect(injected).toBe(true)
    expect(content).toMatch(/tenantId\s+String/)
    expect(content).toMatch(/birthDate\s+DateTime/)
    expect(content).toContain('@@index([tenantId])')
    // reserved 'name' not duplicated
    expect(content.match(/name\s+String/g)?.length).toBe(1)
  })
})

describe('injectZodFields', () => {
  const schema = `import { z } from 'zod'

export const PatientSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Patient = z.infer<typeof PatientSchema>

export const CreatePatientSchema = z.object({
  name: z.string().min(1),
})
`
  it('injects into both entity and create schemas', () => {
    const { content, injected } = injectZodFields(schema, [{ name: 'visits', type: 'number' }])
    expect(injected).toBe(true)
    expect(content).toMatch(/visits: z\.number\(\)\.int\(\),\n {2}createdAt/) // in entity schema after name
    expect(content.match(/visits: z\.number\(\)\.int\(\),/g)?.length).toBe(2) // entity + create
  })
})

describe('runMake (dry-run)', () => {
  it('scaffolds the resource with domain fields and passes the review gate', async () => {
    const result = await runMake(tenantCtx, plan, { dryRun: true, baseDir: '/proj' })
    expect(result.dryRun).toBe(true)
    const patient = result.resources[0]
    expect(patient?.name).toBe('Patient')
    expect(patient?.prisma).toBe(true) // parsed from the plan command
    expect(patient?.softDelete).toBe(true) // parsed from --soft-delete
    expect(patient?.augmented).toBe(true)
    expect(patient?.written).toEqual([]) // dry-run writes nothing

    const model = patient?.files.find((f) => f.path.endsWith('.prisma'))
    expect(model?.content).toMatch(/tenantId\s+String/)
    expect(model?.content).toMatch(/birthDate\s+DateTime/)

    // Review gate: tenant isolation passes, perms/audit/migration are manual warnings.
    const tenantItem = result.review.items.find((i) => i.label === 'Tenant isolation')
    expect(tenantItem?.status).toBe('pass')
    expect(result.review.ok).toBe(true)
    expect(result.followUps.join('\n')).toMatch(/prisma db push/)
    expect(result.followUps.join('\n')).toMatch(/patients\.create/)
  })

  it('throws when the plan has no entity', async () => {
    const empty = { ...plan, entities: [] }
    await expect(runMake(tenantCtx, empty, { dryRun: true })).rejects.toThrow(/no entity/)
  })
})
