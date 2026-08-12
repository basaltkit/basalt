import { describe, expect, it } from 'vitest'
import {
  detectProject,
  injectPermissionGuards,
  memoryReader,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'

// A project with tenancy + RBAC + audit all enabled.
const fullCtx = detectProject(
  '/proj',
  memoryReader({
    'package.json': JSON.stringify({
      dependencies: {
        '@basaltkit/prisma': '^1.0.0',
        '@basaltkit/permissions': '^1.0.0',
        '@basaltkit/audit': '^1.0.0',
      },
    }),
    'src/app.ts':
      'createApp({ plugins: [ tenancyPlugin({}), permissionsPlugin({}), auditPlugin({}), prismaPlugin({}), fastifyPlugin({}) ] })',
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  }),
)

const plan: ArchitecturePlan = {
  request: 'Add a patient module',
  summary: 'Patient resource',
  entities: [{ name: 'Patient', fields: [{ name: 'phone', type: 'String' }], tenantScoped: true }],
  steps: [{ order: 1, title: 'Scaffold', kind: 'generator', detail: '', command: 'basalt make:resource Patient --prisma --soft-delete' }],
  permissions: ['patients.view', 'patients.create', 'patients.update', 'patients.delete'],
  auditEvents: ['patient.created', 'patient.updated', 'patient.deleted'],
  tenantScoped: true,
  warnings: [],
}

describe('injectPermissionGuards (unit)', () => {
  const routes = `export const patientRoutes = [
  route({
    method: 'GET',
    url: '/patients',
    async handler() { return service().list() },
  }),

  route({
    method: 'POST',
    url: '/patients',
    async handler({ body }) { return service().create(body) },
  }),
]`
  it('adds meta.can per method', () => {
    const { content, injected } = injectPermissionGuards(routes, ['patients.view', 'patients.create'])
    expect(injected).toBe(true)
    expect(content).toContain("meta: { can: 'patients.view' },")
    expect(content).toContain("meta: { can: 'patients.create' },")
  })
})

describe('runMake auto-wiring (dry-run)', () => {
  it('guards routes and wires audit when RBAC + audit are enabled', async () => {
    const result = await runMake(fullCtx, plan, { dryRun: true, baseDir: '/proj' })
    const patient = result.resources[0]
    expect(patient?.guarded).toBe(true)
    expect(patient?.audited).toBe(true)

    const routes = patient?.files.find((f) => f.path.endsWith('.routes.ts'))?.content ?? ''
    expect(routes).toContain("meta: { can: 'patients.view' },")
    expect(routes).toContain("meta: { can: 'patients.create' },")
    expect(routes).toContain("meta: { can: 'patients.update' },")
    expect(routes).toContain("meta: { can: 'patients.delete' },")
    // restore route (soft-delete) → update permission
    expect(routes.match(/meta: \{ can: 'patients\.update' \},/g)?.length).toBe(2)

    const service = patient?.files.find((f) => f.path.endsWith('.service.ts'))?.content ?? ''
    expect(service).toContain("import type { Audit } from '@basaltkit/audit'")
    expect(service).toContain('private readonly audit: Audit,')
    expect(service).toContain("this.audit.record('patient.created', created)")
    expect(service).toContain("this.audit.record('patient.updated', updated)")
    expect(service).toContain("this.audit.record('patient.deleted', { id })")

    const plugin = patient?.files.find((f) => f.path.endsWith('.plugin.ts'))?.content ?? ''
    expect(plugin).toContain("import { AUDIT } from '@basaltkit/audit'")
    expect(plugin).toContain('c.get(AUDIT)')

    const perms = result.review.items.find((i) => i.label === 'Permissions')
    const audit = result.review.items.find((i) => i.label === 'Audit')
    expect(perms?.status).toBe('pass')
    expect(audit?.status).toBe('pass')
    expect(result.review.ok).toBe(true)
  })

  it('leaves permissions/audit as manual warnings when those plugins are absent', async () => {
    const bareCtx = detectProject(
      '/bare',
      memoryReader({
        'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1.0.0' } }),
        'src/app.ts': 'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({}) ] })',
        'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }',
      }),
    )
    const result = await runMake(bareCtx, plan, { dryRun: true, baseDir: '/bare' })
    expect(result.resources[0]?.guarded).toBe(false)
    expect(result.resources[0]?.audited).toBe(false)
    expect(result.review.items.find((i) => i.label === 'Permissions')?.status).toBe('warn')
  })
})
