import { BasaltError } from '@basaltkit/core'

export class InvalidTenantSchemaError extends BasaltError {
  constructor(tenantId: string, reason: string) {
    super('PRISMA_INVALID_SCHEMA', `Cannot derive a PostgreSQL schema for tenant "${tenantId}": ${reason}`)
  }
}

export interface TenantSchemaOptions {
  /** Prefix for the schema name. Default: 'tenant_'. */
  prefix?: string
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const PG_MAX_IDENTIFIER = 63

/**
 * Derives a safe PostgreSQL schema identifier for a tenant. Lowercased and
 * sanitized to `[a-z0-9_]`, so it is safe to quote and interpolate.
 */
export function tenantSchema(tenantId: string, options: TenantSchemaOptions = {}): string {
  const prefix = options.prefix ?? 'tenant_'
  const sanitized = tenantId.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  if (sanitized.length === 0 || /^_+$/.test(sanitized)) {
    throw new InvalidTenantSchemaError(tenantId, 'no usable characters')
  }
  const name = `${prefix}${sanitized}`
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new InvalidTenantSchemaError(tenantId, `"${name}" is not a valid identifier`)
  }
  if (name.length > PG_MAX_IDENTIFIER) {
    throw new InvalidTenantSchemaError(tenantId, `"${name}" exceeds ${PG_MAX_IDENTIFIER} chars`)
  }
  return name
}

/**
 * Returns the connection URL with its `schema` set to `schema`. Prisma reads
 * this to set the connection's search_path — the reliable way to do
 * schema-per-tenant (per-connection search_path switching on a shared pool is
 * not dependable with Prisma).
 */
export function schemaUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('schema', schema)
  return url.toString()
}

/** Client surface needed to provision schemas — satisfied by a PrismaClient. */
export interface SchemaProvisioner {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>
}

/**
 * Creates the tenant's schema if it does not exist. The schema name is
 * validated (`[a-z0-9_]`) before interpolation, so quoting is safe.
 */
export async function provisionTenantSchema(
  client: SchemaProvisioner,
  schema: string,
): Promise<void> {
  if (!SAFE_IDENTIFIER.test(schema)) {
    throw new InvalidTenantSchemaError(schema, 'unsafe schema name')
  }
  await client.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}
