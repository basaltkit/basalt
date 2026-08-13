import { describe, expect, it } from 'vitest'
import {
  detectProject,
  memoryReader,
  parsePlan,
  renderPrismaRepository,
  runMake,
  zodForField,
  type ArchitecturePlan,
} from '../src/index.js'

describe('zodForField', () => {
  it('produces z.enum for an enum field (same for entity and create)', () => {
    const f = { name: 'estado', type: 'String', enum: ['pago', 'pendente'] }
    expect(zodForField(f, false)).toBe("z.enum(['pago', 'pendente'])")
    expect(zodForField(f, true)).toBe("z.enum(['pago', 'pendente'])")
  })

  it('falls back to the base validator without an enum', () => {
    expect(zodForField({ name: 'x', type: 'String' }, true)).toBe('z.string().min(1)')
  })
})

describe('parsePlan enum', () => {
  it('parses the enum values off a field', () => {
    const plan = parsePlan(
      JSON.stringify({ entities: [{ name: 'Fatura', tenantScoped: true, fields: [{ name: 'estado', type: 'String', enum: ['pago', 'pendente'] }] }] }),
      'r',
    )
    expect(plan.entities[0]?.fields[0]?.enum).toEqual(['pago', 'pendente'])
  })
})

describe('renderPrismaRepository enum', () => {
  it('stores the enum as a String row but narrows it in the mapper', () => {
    const src = renderPrismaRepository('Fatura', [{ name: 'estado', type: 'String', enum: ['pago', 'pendente'] }], {
      softDelete: false,
      tenantScoped: true,
      keepName: false,
    })
    expect(src).toContain('estado: string') // row type
    expect(src).toContain("estado: r.estado as 'pago' | 'pendente',") // mapper cast
  })
})

describe('runMake enum (end to end)', () => {
  it('emits z.enum in the Zod schema and a String column in Prisma', async () => {
    const ctx = detectProject(
      '/p',
      memoryReader({
        'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }),
        'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
        'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
      }),
    )
    const plan: ArchitecturePlan = {
      request: 'faturas',
      summary: 's',
      entities: [
        {
          name: 'Fatura',
          tenantScoped: true,
          fields: [
            { name: 'numero', type: 'String' },
            { name: 'estado', type: 'String', enum: ['pago', 'pendente'] },
          ],
        },
      ],
      steps: [{ order: 1, title: 'x', kind: 'generator', detail: '', command: 'basalt make:resource Fatura --prisma' }],
      permissions: [],
      auditEvents: [],
      tenantScoped: true,
      warnings: [],
    }
    const r = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })
    const schema = r.resources[0]?.files.find((f) => f.path.endsWith('.schema.ts'))?.content ?? ''
    const model = r.resources[0]?.files.find((f) => f.path.endsWith('.prisma'))?.content ?? ''
    expect(schema).toContain("estado: z.enum(['pago', 'pendente'])")
    expect(model).toMatch(/estado\s+String/) // stored as String, no Prisma enum block
  })
})
