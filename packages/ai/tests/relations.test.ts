import { describe, expect, it } from 'vitest'
import {
  detectProject,
  memoryReader,
  parsePlan,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'

const ctx = detectProject(
  '/p',
  memoryReader({
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }),
    'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  }),
)

function modelOf(r: Awaited<ReturnType<typeof runMake>>, name: string): string {
  return r.resources.find((x) => x.name === name)?.files.find((f) => f.path.endsWith('.prisma'))?.content ?? ''
}

describe('parsePlan relations', () => {
  it('normalizes a bare model name into { name, model }', () => {
    const plan = parsePlan(
      JSON.stringify({ entities: [{ name: 'Consulta', tenantScoped: true, relations: ['Paciente'] }] }),
      'r',
    )
    expect(plan.entities[0]?.relations).toEqual([{ name: 'paciente', model: 'Paciente' }])
  })
})

describe('real Prisma relations', () => {
  const plan: ArchitecturePlan = {
    request: 'consultas',
    summary: 's',
    entities: [
      { name: 'Paciente', tenantScoped: true, fields: [{ name: 'nome', type: 'String' }] },
      {
        name: 'Consulta',
        tenantScoped: true,
        relations: [{ name: 'paciente', model: 'Paciente' }],
        fields: [{ name: 'inicio', type: 'DateTime' }],
      },
    ],
    steps: [
      { order: 1, title: 'a', kind: 'generator', detail: '', command: 'basalt make:resource Paciente --prisma' },
      { order: 2, title: 'b', kind: 'generator', detail: '', command: 'basalt make:resource Consulta --prisma' },
    ],
    permissions: [],
    auditEvents: [],
    tenantScoped: true,
    warnings: [],
  }

  it('generates the FK column, the @relation field and the inverse hasMany', async () => {
    const r = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })

    const consulta = modelOf(r, 'Consulta')
    expect(consulta).toMatch(/pacienteId\s+String/) // FK column
    expect(consulta).toContain('paciente Paciente @relation(fields: [pacienteId], references: [id])')

    const paciente = modelOf(r, 'Paciente')
    expect(paciente).toContain('consultas Consulta[]') // inverse hasMany

    // no external follow-up: both sides are in the plan
    expect(r.followUps.join('\n')).not.toMatch(/not in this plan/)
  })

  it('FK is also a validated field in the Zod create schema', async () => {
    const r = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })
    const schema = r.resources.find((x) => x.name === 'Consulta')?.files.find((f) => f.path.endsWith('.schema.ts'))?.content ?? ''
    expect(schema).toContain('pacienteId: z.string().min(1)')
  })

  it('does not duplicate the FK column when the plan also lists it as a field', async () => {
    const dup: ArchitecturePlan = {
      ...plan,
      entities: [
        plan.entities[0]!,
        { ...plan.entities[1]!, fields: [{ name: 'pacienteId', type: 'String' }, { name: 'inicio', type: 'DateTime' }] },
      ],
    }
    const r = await runMake(ctx, dup, { dryRun: true, baseDir: '/p' })
    const consulta = modelOf(r, 'Consulta')
    expect(consulta.match(/^\s*pacienteId\s+String/gm)?.length).toBe(1)
  })
})
