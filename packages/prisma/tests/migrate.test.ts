import { describe, expect, it, vi } from 'vitest'
import { createApp } from '@basaltkit/core'
import { commandsPlugin, memoryIo, runCli } from '@basaltkit/cli'
import {
  migrateTenants,
  tenantMigrateCommand,
  type MigrateFn,
  type SchemaProvisioner,
} from '../src/index.js'

describe('migrateTenants', () => {
  it('schema mode: provisions the schema and migrates each with the scoped URL', async () => {
    const provisioned: string[] = []
    const provision: SchemaProvisioner = {
      async $executeRawUnsafe(query) {
        provisioned.push(query)
        return 0
      },
    }
    const migrated: { tenantId: string; url: string; schema?: string }[] = []
    const migrate: MigrateFn = async (info) => void migrated.push(info)

    const results = await migrateTenants({
      tenants: ['acme', 'globex'],
      target: { mode: 'schema', url: 'postgresql://host/app', provision },
      migrate,
    })

    expect(results.every((r) => r.ok)).toBe(true)
    expect(migrated).toEqual([
      { tenantId: 'acme', url: 'postgresql://host/app?schema=tenant_acme', schema: 'tenant_acme' },
      { tenantId: 'globex', url: 'postgresql://host/app?schema=tenant_globex', schema: 'tenant_globex' },
    ])
    expect(provisioned).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "tenant_acme"',
      'CREATE SCHEMA IF NOT EXISTS "tenant_globex"',
    ])
  })

  it('database mode: uses urlFor, no provisioning', async () => {
    const migrated: string[] = []
    const results = await migrateTenants({
      tenants: ['acme'],
      target: { mode: 'database', urlFor: (id) => `postgresql://host/${id}` },
      migrate: async ({ url }) => void migrated.push(url),
    })
    expect(migrated).toEqual(['postgresql://host/acme'])
    expect(results[0]).toMatchObject({ tenantId: 'acme', url: 'postgresql://host/acme', ok: true })
    expect(results[0]?.schema).toBeUndefined()
  })

  it('isolates failures — one bad tenant does not abort the rest', async () => {
    const results = await migrateTenants({
      tenants: ['ok1', 'boom', 'ok2'],
      target: { mode: 'database', urlFor: (id) => `postgresql://host/${id}` },
      migrate: async ({ tenantId }) => {
        if (tenantId === 'boom') throw new Error('migration failed')
      },
    })
    expect(results.map((r) => [r.tenantId, r.ok])).toEqual([
      ['ok1', true],
      ['boom', false],
      ['ok2', true],
    ])
    expect(results[1]?.error).toBe('migration failed')
  })

  it('a provision failure is reported and migrate is skipped', async () => {
    const migrate = vi.fn<MigrateFn>(async () => {})
    const provision: SchemaProvisioner = {
      async $executeRawUnsafe() {
        throw new Error('permission denied')
      },
    }
    const results = await migrateTenants({
      tenants: ['acme'],
      target: { mode: 'schema', url: 'postgresql://host/app', provision },
      migrate,
    })
    expect(results[0]).toMatchObject({ ok: false, error: 'permission denied' })
    expect(migrate).not.toHaveBeenCalled()
  })
})

describe('tenant:migrate command', () => {
  const runCommand = async (tenants: string[], migrate: MigrateFn) => {
    const io = memoryIo()
    const app = createApp({
      plugins: [
        commandsPlugin([
          tenantMigrateCommand({
            tenants: () => tenants,
            target: { mode: 'database', urlFor: (id) => `postgresql://host/${id}` },
            migrate,
          }),
        ]),
      ],
    })
    const code = await runCli({ app, argv: ['tenant:migrate'], io })
    return { code, io }
  }

  it('reports per tenant and exits 0 when all succeed', async () => {
    const { code, io } = await runCommand(['acme', 'globex'], async () => {})
    expect(code).toBe(0)
    const output = io.lines.join('\n')
    expect(output).toContain('Migrating 2 tenant(s)')
    expect(output).toContain('ok   acme')
    expect(output).toContain('Done: 2 migrated, 0 failed.')
  })

  it('exits 1 when a tenant fails', async () => {
    const { code, io } = await runCommand(['acme', 'bad'], async ({ tenantId }) => {
      if (tenantId === 'bad') throw new Error('nope')
    })
    expect(code).toBe(1)
    expect(io.lines.join('\n')).toContain('FAIL bad — nope')
  })

  it('handles the empty case', async () => {
    const { code, io } = await runCommand([], async () => {})
    expect(code).toBe(0)
    expect(io.lines).toContain('No tenants to migrate.')
  })
})
