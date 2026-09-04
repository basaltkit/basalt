import { describe, expect, it } from 'vitest'
import {
  detectProject,
  memoryReader,
  renderPrismaRepository,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'

const ctx = detectProject(
  '/p',
  memoryReader({
    'package.json': JSON.stringify({
      dependencies: { '@basaltkit/prisma': '^1', '@basaltkit/permissions': '^1' },
    }),
    'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), permissionsPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  }),
)

function plan(entities: ArchitecturePlan['entities'], perms: string[] = [], steps: ArchitecturePlan['steps'] = []): ArchitecturePlan {
  return {
    request: 'r',
    summary: 's',
    entities,
    steps,
    permissions: perms,
    auditEvents: [],
    tenantScoped: true,
    warnings: [],
  }
}

// ── Fix #1 + #2: repository with explicit tenant scoping + complete mapper ──
describe('renderPrismaRepository', () => {
  const fields = [
    { name: 'phone', type: 'String' },
    { name: 'visits', type: 'number' },
    { name: 'startsAt', type: 'DateTime' },
  ]

  it('tenant-scoped + soft-delete: scopes tenantId explicitly and maps every field', () => {
    const src = renderPrismaRepository('Patient', fields, { softDelete: true, tenantScoped: true, keepName: false })
    expect(src).toContain("import { createToken, tryCtx } from '@basaltkit/core'")
    expect(src).toContain('const currentTenantId')
    // a missing tenant is a clear 400, not a silent 500
    expect(src).toContain("import { HttpError } from '@basaltkit/fastify'")
    expect(src).toContain("throw new HttpError(400, 'TENANT_REQUIRED'")
    expect(src).toContain('data: { ...input, tenantId: currentTenantId() }')
    expect(src).toContain('findMany({ where: { tenantId: currentTenantId(), deletedAt: null } })')
    expect(src).toContain('updateMany({ where: { id, tenantId: currentTenantId(), deletedAt: null }')
    expect(src).toContain('restore')
    // complete mapper — domain fields present, DateTime → ISO string
    expect(src).toContain('phone: r.phone,')
    expect(src).toContain('visits: r.visits,')
    expect(src).toContain('startsAt: r.startsAt.toISOString(),')
    expect(src).not.toContain('name: r.name,') // keepName false
  })

  it('non-tenant: no tenant helper, update/delete by unique id', () => {
    const src = renderPrismaRepository('Speciality', [{ name: 'code', type: 'String' }], {
      softDelete: false,
      tenantScoped: false,
      keepName: false,
    })
    expect(src).not.toContain('currentTenantId')
    expect(src).toContain("import { createToken } from '@basaltkit/core'")
    expect(src).toContain('this.records.update({ where: { id }, data: input })')
    expect(src).toContain('this.records.delete({ where: { id } })')
    expect(src).toContain('code: r.code,')
  })

  it('keepName includes the base name column', () => {
    const src = renderPrismaRepository('Tag', [{ name: 'colour', type: 'String' }], {
      softDelete: false,
      tenantScoped: true,
      keepName: true,
    })
    expect(src).toContain('name: r.name,')
    expect(src).toContain('colour: r.colour,')
  })
})

// ── Fix #4: spurious base `name` column ──
describe('base name column', () => {
  it('is dropped when the entity has its own fields and none is `name`', async () => {
    const p = plan(
      // `label` and `email` — deliberately NOT a field called `name`, which is
      // the whole distinction this test draws.
      [{ name: 'Client', tenantScoped: true, fields: [{ name: 'label', type: 'String' }, { name: 'email', type: 'String' }] }],
      [],
      [{ order: 1, kind: 'generator', title: 'x', detail: '', command: 'basalt make:resource Client --prisma' }],
    )
    const res = (await runMake(ctx, p, { dryRun: true, baseDir: '/p' })).resources[0]
    const model = res?.files.find((f) => f.path.endsWith('.prisma'))?.content ?? ''
    const schema = res?.files.find((f) => f.path.endsWith('.schema.ts'))?.content ?? ''
    expect(model).not.toMatch(/^\s*name\s+String/m)
    expect(model).toMatch(/label\s+String/)
    expect(schema).not.toContain('name: z.string()')
    expect(schema).toContain('label: z.string()')
  })

  it('is kept when the entity has a `name` field', async () => {
    const p = plan(
      [{ name: 'Tag', tenantScoped: true, fields: [{ name: 'name', type: 'String' }, { name: 'colour', type: 'String' }] }],
      [],
      [{ order: 1, kind: 'generator', title: 'x', detail: '', command: 'basalt make:resource Tag --prisma' }],
    )
    const res = (await runMake(ctx, p, { dryRun: true, baseDir: '/p' })).resources[0]
    const model = res?.files.find((f) => f.path.endsWith('.prisma'))?.content ?? ''
    expect(model.match(/^\s*name\s+String/gm)?.length).toBe(1) // exactly one, no duplicate
    // The entity's own other field still lands — the base column is dropped,
    // not the declared ones.
    expect(model).toMatch(/colour\s+String/)
  })
})

// ── Fix #5: per-entity permission namespace in multi-entity plans ──
describe('multi-entity permission guards', () => {
  it('guards each entity with its own namespace, not a shared one', async () => {
    const p = plan(
      [
        { name: 'Paciente', tenantScoped: true, fields: [{ name: 'name', type: 'String' }] },
        { name: 'Medico', tenantScoped: true, fields: [{ name: 'crm', type: 'String' }] },
      ],
      ['consultas.view'], // deliberately a mismatched flat list
      [
        { order: 1, kind: 'generator', title: 'a', detail: '', command: 'basalt make:resource Paciente --prisma' },
        { order: 2, kind: 'generator', title: 'b', detail: '', command: 'basalt make:resource Medico --prisma' },
      ],
    )
    const r = await runMake(ctx, p, { dryRun: true, baseDir: '/p' })
    const routesOf = (name: string) =>
      r.resources.find((x) => x.name === name)?.files.find((f) => f.path.endsWith('.routes.ts'))?.content ?? ''
    expect(routesOf('Paciente')).toContain("can: 'pacientes.view'")
    expect(routesOf('Medico')).toContain("can: 'medicos.view'")
    expect(routesOf('Paciente')).not.toContain('consultas')
    expect(routesOf('Medico')).not.toContain('pacientes')
  })
})

// ── Fix #3: follow-up text; external-relation note ──
describe('follow-ups', () => {
  it('recommends prisma db push and notes a relation to a model not in the plan', async () => {
    const p = plan(
      [{ name: 'Consulta', tenantScoped: true, relations: [{ name: 'paciente', model: 'Paciente' }], fields: [{ name: 'inicio', type: 'DateTime' }] }],
      [],
      [{ order: 1, kind: 'generator', title: 'x', detail: '', command: 'basalt make:resource Consulta --prisma' }],
    )
    const r = await runMake(ctx, p, { dryRun: true, baseDir: '/p' })
    const text = r.followUps.join('\n')
    expect(text).toMatch(/prisma db push/)
    expect(text).not.toMatch(/prisma:sync/)
    expect(text).toMatch(/not in this plan \(Paciente\)/)
  })
})
