import { describe, expect, it } from 'vitest'
import { createApp, METADATA } from '@machize/core'
import {
  DB_POOL,
  InvalidTenantSchemaError,
  prismaPlugin,
  provisionTenantSchema,
  schemaUrl,
  tenantSchema,
} from '../src/index.js'

describe('tenantSchema', () => {
  it('derives a safe, prefixed, lowercased identifier', () => {
    expect(tenantSchema('acme')).toBe('tenant_acme')
    expect(tenantSchema('Acme-Corp')).toBe('tenant_acme_corp')
    expect(tenantSchema('acme', { prefix: 'org_' })).toBe('org_acme')
  })

  it('rejects unusable or over-long ids', () => {
    expect(() => tenantSchema('')).toThrowError(InvalidTenantSchemaError)
    expect(() => tenantSchema('---')).toThrowError(InvalidTenantSchemaError)
    expect(() => tenantSchema('x'.repeat(70))).toThrowError(InvalidTenantSchemaError)
  })
})

describe('schemaUrl', () => {
  it('sets the schema query param, preserving the rest', () => {
    expect(schemaUrl('postgresql://u:p@host:5432/app', 'tenant_acme')).toBe(
      'postgresql://u:p@host:5432/app?schema=tenant_acme',
    )
    // replaces an existing schema param, keeps others
    expect(schemaUrl('postgresql://host/app?sslmode=require&schema=public', 'tenant_x')).toContain(
      'schema=tenant_x',
    )
    expect(schemaUrl('postgresql://host/app?sslmode=require&schema=public', 'tenant_x')).toContain(
      'sslmode=require',
    )
  })
})

describe('provisionTenantSchema', () => {
  it('issues CREATE SCHEMA IF NOT EXISTS with the quoted name', async () => {
    const executed: string[] = []
    const client = {
      async $executeRawUnsafe(query: string) {
        executed.push(query)
        return 0
      },
    }
    await provisionTenantSchema(client, 'tenant_acme')
    expect(executed).toEqual(['CREATE SCHEMA IF NOT EXISTS "tenant_acme"'])
  })

  it('refuses an unsafe schema name (no interpolation of injection)', async () => {
    const client = { async $executeRawUnsafe() { return 0 } }
    await expect(provisionTenantSchema(client, 'evil"; DROP SCHEMA public; --')).rejects.toBeInstanceOf(
      InvalidTenantSchemaError,
    )
  })
})

describe('prismaPlugin schema-per-tenant mode', () => {
  it('builds one client per tenant with the schema-scoped URL, via the pool', async () => {
    const created: string[] = []
    const app = await createApp({
      plugins: [
        prismaPlugin({
          schemaPerTenant: {
            url: 'postgresql://u:p@host:5432/app',
            createClient: (url) => {
              created.push(url)
              return { url }
            },
          },
        }),
      ],
    }).boot()

    const enricher = app.container
      .get(METADATA)
      .get<(info: { context: Record<string, unknown> }) => Promise<void>>('http:enrichers')[0]!

    const acme: Record<string, unknown> = { tenant: { id: 'acme' } }
    const globex: Record<string, unknown> = { tenant: { id: 'globex' } }
    await enricher({ context: acme })
    await enricher({ context: globex })

    expect(acme['db']).toEqual({ url: 'postgresql://u:p@host:5432/app?schema=tenant_acme' })
    expect(globex['db']).toEqual({ url: 'postgresql://u:p@host:5432/app?schema=tenant_globex' })
    expect(created).toEqual([
      'postgresql://u:p@host:5432/app?schema=tenant_acme',
      'postgresql://u:p@host:5432/app?schema=tenant_globex',
    ])
    expect(app.container.get(DB_POOL).size).toBe(2)

    // reuses the client for the same tenant
    await enricher({ context: { tenant: { id: 'acme' } } })
    expect(created).toHaveLength(2)
    await app.shutdown()
  })
})
