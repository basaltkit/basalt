import { describe, expect, it } from 'vitest'
import {
  detectProject,
  memoryReader,
  permissionList,
  renderPermissionsFile,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'

describe('permissionList', () => {
  it('matches the route-guard namespace (plural.action)', () => {
    expect(permissionList('Client')).toEqual([
      'clients.view',
      'clients.create',
      'clients.update',
      'clients.delete',
    ])
  })
})

describe('renderPermissionsFile', () => {
  const src = renderPermissionsFile('Client')
  it('declares the constants and a grant helper', () => {
    expect(src).toContain("import { GLOBAL_SCOPE, type AccessStore } from '@basaltkit/permissions'")
    expect(src).toContain('export const CLIENT_PERMISSIONS = [')
    expect(src).toContain("'clients.create',")
    expect(src).toContain('export async function grantClientPermissions(')
    expect(src).toContain('await store.grantToRole(role, [...CLIENT_PERMISSIONS], scope)')
  })
})

describe('runMake permission registration', () => {
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
    entities: [{ name: 'Client', tenantScoped: true, fields: [{ name: 'name', type: 'String' }] }],
    steps: [{ order: 1, title: 'x', kind: 'generator', detail: '', command: 'basalt make:resource Client --prisma' }],
    permissions: ['clients.view', 'clients.create', 'clients.update', 'clients.delete'],
    auditEvents: [],
    tenantScoped: true,
    warnings: [],
  }

  it('emits a <name>.permissions.ts and points the follow-up at the grant helper', async () => {
    const r = await runMake(ctx, plan, { dryRun: true, baseDir: '/p' })
    const files = r.resources[0]?.files.map((f) => f.path) ?? []
    expect(files).toContain('src/modules/client/client.permissions.ts')

    const perms = r.resources[0]?.files.find((f) => f.path.endsWith('.permissions.ts'))?.content ?? ''
    expect(perms).toContain('grantClientPermissions')

    expect(r.followUps.join('\n')).toContain("grantClientPermissions(store, 'admin')")
    expect(r.review.items.find((i) => i.label === 'Permissions')?.status).toBe('pass')
  })

  it('emits no permissions file when RBAC is not enabled', async () => {
    const noRbac = detectProject(
      '/q',
      memoryReader({
        'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }),
        'src/app.ts': 'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({}) ] })',
        'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }',
      }),
    )
    const r = await runMake(noRbac, plan, { dryRun: true, baseDir: '/q' })
    expect(r.resources[0]?.files.some((f) => f.path.endsWith('.permissions.ts'))).toBe(false)
  })
})
