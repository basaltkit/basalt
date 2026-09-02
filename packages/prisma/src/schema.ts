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

/** The Prisma connectors we can tell apart from a connection URL. */
export type DatabaseProvider = 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'mongodb' | 'unknown'

/**
 * The provider behind a connection URL, by scheme.
 *
 * Deliberately shallow: this exists to answer one question — "can this database
 * do schema-per-tenant?" — not to model dialects. Prisma already abstracts those,
 * and the two places Basalt is provider-specific are precisely the two Prisma
 * does NOT abstract, because they have no cross-dialect equivalent.
 */
export function providerOf(url: string): DatabaseProvider {
  const scheme = url.slice(0, Math.max(0, url.indexOf(':'))).toLowerCase()
  if (scheme === 'postgresql' || scheme === 'postgres') return 'postgresql'
  if (scheme === 'mysql') return 'mysql'
  if (scheme === 'file' || scheme === 'sqlite') return 'sqlite'
  if (scheme === 'sqlserver') return 'sqlserver'
  if (scheme === 'mongodb' || scheme === 'mongodb+srv') return 'mongodb'
  return 'unknown'
}

export class SchemaPerTenantUnsupportedError extends BasaltError {
  constructor(provider: DatabaseProvider) {
    super(
      'PRISMA_SCHEMA_PER_TENANT_UNSUPPORTED',
      `Schema-per-tenant needs PostgreSQL; this connection is ${provider}. ` +
        'It relies on a schema being a namespace INSIDE a database, selected by the ' +
        "connection's search_path — in MySQL a \"schema\" IS a database, and SQLite has no " +
        'equivalent. Use database-per-tenant instead: `forTenant` on prismaPlugin, or ' +
        "`{ mode: 'database', urlFor }` when migrating. It gives stronger isolation anyway.",
    )
  }
}

/**
 * Fails loud when schema-per-tenant is configured against a database that cannot
 * do it — at boot, or when a migration target is resolved.
 *
 * Without this the first symptom is a raw `CREATE SCHEMA` syntax error from the
 * driver, at tenant-creation time, far from the configuration that caused it.
 * An `unknown` scheme is allowed through: a proxy or custom URL should not be
 * refused on a guess.
 */
export function assertSchemaPerTenantSupported(url: string): void {
  const provider = providerOf(url)
  if (provider === 'postgresql' || provider === 'unknown') return
  throw new SchemaPerTenantUnsupportedError(provider)
}
