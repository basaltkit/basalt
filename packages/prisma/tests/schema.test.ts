import { describe, expect, it } from 'vitest'
import { createApp, METADATA } from '@basaltkit/core'
import {
  DB_POOL,
  InvalidTenantSchemaError,
  prismaPlugin,
  provisionTenantSchema,
  schemaUrl,
  tenantSchema,
} from '../src/index.js'

describe('tenantSchema', () => {
  it('derives a safe, prefixed identifier (non-canonical ids get a hash suffix)', () => {
    expect(tenantSchema('acme')).toBe('tenant_acme')
    expect(tenantSchema('Acme-Corp')).toMatch(/^tenant_acme_corp__[0-9a-f]{16}$/)
    expect(tenantSchema('acme', { prefix: 'org_' })).toBe('org_acme')
  })

  it('is injective: distinct tenant ids never share a schema (F05)', () => {
    const ids = ['acme', 'ACME', 'Acme', 'acme-co', 'acme_co', 'acme.co', 'acme co', 'acme__co', 'acme_', '_acme']
    const schemas = ids.map((id) => tenantSchema(id))
    expect(new Set(schemas).size).toBe(ids.length)
    // canonical ids keep their readable, backward-compatible name
    expect(tenantSchema('acme')).toBe('tenant_acme')
    expect(tenantSchema('acme_co')).toBe('tenant_acme_co')
    // a canonical id can never be crafted to equal the encoding of another id
    const encoded = tenantSchema('acme-co')
    expect(encoded).toMatch(/^tenant_acme_co__[0-9a-f]{16}$/)
    expect(() => tenantSchema(encoded.slice('tenant_'.length))).not.toThrow()
    expect(tenantSchema(encoded.slice('tenant_'.length))).not.toBe(encoded)
    for (const schema of schemas) expect(schema.length).toBeLessThanOrEqual(63)
  })

  it('refuses ids with lone UTF-16 surrogates (they hash like U+FFFD and would share a schema)', () => {
    // UTF-8 encodes every lone surrogate as U+FFFD, so without this check
    // 'acme\uD800', 'acme\uDC00' and 'acme\uFFFD' all mapped to one schema.
    expect(() => tenantSchema('acme\uD800')).toThrowError(InvalidTenantSchemaError)
    expect(() => tenantSchema('acme\uDC00')).toThrowError(InvalidTenantSchemaError)
    expect(() => tenantSchema('\uDFFFacme')).toThrowError(InvalidTenantSchemaError)
    // well-formed ids, including astral characters and U+FFFD itself, still work
    expect(tenantSchema('acme\uFFFD')).toMatch(/^tenant_acme__[0-9a-f]{16}$/)
    expect(tenantSchema('acme\u{1F600}')).not.toBe(tenantSchema('acme\uFFFD'))
  })

  it('encodes long non-canonical ids (e.g. UUIDs) within the 63-char limit', () => {
    const uuid = '550E8400-E29B-41D4-A716-446655440000'
    const schema = tenantSchema(uuid)
    expect(schema.length).toBeLessThanOrEqual(63)
    expect(schema).not.toBe(tenantSchema(uuid.toLowerCase()))
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
