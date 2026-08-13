import { describe, expect, it } from 'vitest'
import {
  detectProject,
  injectOpenApiMeta,
  memoryReader,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'

describe('injectOpenApiMeta (unit)', () => {
  it('adds summary + tags, merging into an existing guard meta', () => {
    const routes = `export const clienteRoutes = [
  route({
    method: 'GET',
    url: '/clientes',
    meta: { can: 'clientes.view' },
    async handler() { return service().list() },
  }),

  route({
    method: 'POST',
    url: '/clientes',
    async handler({ body }) { return service().create(body) },
  }),
]`
    const { content } = injectOpenApiMeta(routes, 'Cliente')
    // merged with the existing can guard
    expect(content).toContain("meta: { can: 'clientes.view', summary: 'List clientes', tags: ['Cliente'] },")
    // created where there was no meta
    expect(content).toContain("meta: { summary: 'Create a cliente', tags: ['Cliente'] },")
  })

  it('names each CRUD verb sensibly (multi-word kebab)', () => {
    const routes = `[
  route({
    method: 'GET',
    url: '/schedule-slots/:id',
    async handler() {},
  }),
  route({
    method: 'DELETE',
    url: '/schedule-slots/:id',
    async handler() {},
  }),
  route({
    method: 'POST',
    url: '/schedule-slots/:id/restore',
    async handler() {},
  }),
]`
    const { content } = injectOpenApiMeta(routes, 'ScheduleSlot')
    expect(content).toContain("summary: 'Get a schedule slot'")
    expect(content).toContain("summary: 'Delete a schedule slot'")
    expect(content).toContain("summary: 'Restore a schedule slot'")
    expect(content).toContain("tags: ['ScheduleSlot']")
  })
})

describe('runMake OpenAPI enrichment', () => {
  it('enriches the generated routes with summary + tags (+ keeps the guards)', async () => {
    const ctx = detectProject(
      '/p',
      memoryReader({
        'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1', '@basaltkit/permissions': '^1' } }),
        'src/app.ts': 'createApp({ plugins: [ tenancyPlugin({}), permissionsPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
        'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
      }),
    )
    const plan: ArchitecturePlan = {
      request: 'r',
      summary: 's',
      entities: [{ name: 'Cliente', tenantScoped: true, fields: [{ name: 'nome', type: 'String' }] }],
      steps: [{ order: 1, title: 'x', kind: 'generator', detail: '', command: 'basalt make:resource Cliente --prisma' }],
      permissions: ['clientes.view', 'clientes.create', 'clientes.update', 'clientes.delete'],
      auditEvents: [],
      tenantScoped: true,
      warnings: [],
    }
    const r = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })
    const routes = r.resources[0]?.files.find((f) => f.path.endsWith('.routes.ts'))?.content ?? ''
    expect(routes).toContain("summary: 'List clientes'")
    expect(routes).toContain("summary: 'Create a cliente'")
    expect(routes).toContain("tags: ['Cliente']")
    // guard + openapi coexist in one meta object
    expect(routes).toContain("can: 'clientes.create'")
    expect(routes).toMatch(/can: 'clientes\.create', summary: 'Create a cliente', tags: \['Cliente'\]/)
  })
})
