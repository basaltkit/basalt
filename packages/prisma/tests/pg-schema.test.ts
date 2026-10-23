import { describe, expect, it } from 'vitest'
import { pgSchemaClient, pgSchemaConnection, PgSchemaConnectionError, schemaUrl, tenantSchema } from '../src/index.js'

const BASE = 'postgresql://app:secret@db.example.com:5432/acme'
const options = (connectionString: string) => new URL(connectionString).searchParams.get('options')

describe('pgSchemaConnection', () => {
  it('moves the schema from ?schema= to the connection search_path', () => {
    const c = pgSchemaConnection(schemaUrl(BASE, 'tenant_acme'))
    expect(c.schema).toBe('tenant_acme')
    expect(c.searchPath).toEqual(['tenant_acme', 'public'])
    const url = new URL(c.connectionString)
    expect(url.searchParams.has('schema')).toBe(false)
    expect(url.searchParams.get('options')).toBe('-c search_path=tenant_acme,public')
    // the rest of the URL is untouched
    expect(`${url.protocol}//${url.username}:${url.password}@${url.host}${url.pathname}`).toBe(BASE)
  })

  it('works on what schemaPerTenant builds for an encoded tenant id', () => {
    const schema = tenantSchema('Acme-Co')
    expect(pgSchemaConnection(schemaUrl(BASE, schema)).searchPath[0]).toBe(schema)
  })

  it('keeps the other query parameters and appends to existing options', () => {
    const c = pgSchemaConnection(`${BASE}?sslmode=require&options=-c%20statement_timeout%3D5000&schema=tenant_acme`)
    const url = new URL(c.connectionString)
    expect(url.searchParams.get('sslmode')).toBe('require')
    expect(url.searchParams.get('options')).toBe('-c statement_timeout=5000 -c search_path=tenant_acme,public')
  })

  it('takes the fallback schemas, and [] for the tenant schema alone', () => {
    expect(pgSchemaConnection(schemaUrl(BASE, 'tenant_acme'), { fallback: ['extensions', 'public'] }).searchPath)
      .toEqual(['tenant_acme', 'extensions', 'public'])
    const alone = pgSchemaConnection(schemaUrl(BASE, 'tenant_acme'), { fallback: [] })
    expect(alone.searchPath).toEqual(['tenant_acme'])
    expect(options(alone.connectionString)).toBe('-c search_path=tenant_acme')
  })

  it('does not repeat the schema when it is also a fallback', () => {
    expect(pgSchemaConnection(schemaUrl(BASE, 'public')).searchPath).toEqual(['public'])
  })

  it('fails closed without ?schema= instead of connecting to the default schema', () => {
    expect(() => pgSchemaConnection(BASE)).toThrow(PgSchemaConnectionError)
    expect(() => pgSchemaConnection(`${BASE}?schema=`)).toThrow(/no \?schema=/)
  })

  it('refuses a schema or a fallback that is not a plain identifier', () => {
    for (const bad of ['Tenant', 'tenant-acme', 'a,public', 'x -c role=admin', '1st', 'a'.repeat(64)]) {
      expect(() => pgSchemaConnection(schemaUrl(BASE, bad))).toThrow(PgSchemaConnectionError)
    }
    expect(() => pgSchemaConnection(schemaUrl(BASE, 'tenant_acme'), { fallback: ['public; drop'] })).toThrow(PgSchemaConnectionError)
  })

  it('refuses a URL it cannot parse, without echoing it', () => {
    let error: unknown
    try { pgSchemaConnection('not a url with p4ssw0rd') } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(PgSchemaConnectionError)
    expect((error as Error).message).not.toContain('p4ssw0rd')
  })
})

describe('pgSchemaClient', () => {
  it('hands the build function the connection for the URL it receives', async () => {
    const seen: unknown[] = []
    const createClient = pgSchemaClient((connection) => { seen.push(connection); return { schema: connection.schema } })
    expect(await createClient(schemaUrl(BASE, 'tenant_globex'))).toEqual({ schema: 'tenant_globex' })
    expect(seen).toEqual([pgSchemaConnection(schemaUrl(BASE, 'tenant_globex'))])
  })

  it('passes the options through and supports an async build', async () => {
    const createClient = pgSchemaClient(async (c) => c.searchPath, { fallback: [] })
    expect(await createClient(schemaUrl(BASE, 'tenant_acme'))).toEqual(['tenant_acme'])
  })

  it('never calls build for a URL without a schema', () => {
    let called = false
    const createClient = pgSchemaClient(() => { called = true })
    expect(() => createClient(BASE)).toThrow(PgSchemaConnectionError)
    expect(called).toBe(false)
  })
})
