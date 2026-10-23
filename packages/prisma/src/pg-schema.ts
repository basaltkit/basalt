import { BasaltError } from '@basaltkit/core'

/**
 * Schema-per-tenant on PostgreSQL, independent of the Prisma version.
 *
 * `prismaPlugin({ schemaPerTenant })` hands `createClient` a URL whose
 * `?schema=` names the tenant's schema. Prisma 6 read that parameter itself;
 * a Prisma 7 driver adapter ignores it, and a client built from the bare URL
 * runs every tenant in `public`. A client built straight on a node-postgres
 * pool (the direction Prisma 8 takes) has no `schema` parameter either.
 *
 * So the schema is applied at the PostgreSQL level, where every version and
 * every driver honours it: the connection's `search_path`, set in the libpq
 * `options` parameter that node-postgres reads from the connection string.
 * {@link pgSchemaConnection} computes that connection; the client it becomes
 * is the application's — built with whatever its Prisma version needs.
 */

export class PgSchemaConnectionError extends BasaltError {
  constructor(message: string) {
    super('PRISMA_PG_SCHEMA_CONNECTION', message)
  }
}

/** The connection a PostgreSQL client needs to work inside one schema. */
export interface PgSchemaConnection {
  /**
   * The URL without `?schema=`, with `options=-c search_path=<schema>,…`
   * (appended to any `options` the URL already had). Pass it to the driver
   * as is: `new PrismaPg({ connectionString })` on Prisma 7, a `pg.Pool` on
   * Prisma 8.
   */
  connectionString: string
  /** The schema the URL named — for an adapter that takes it too (`new PrismaPg(…, { schema })`). */
  schema: string
  /** The search_path set on the connection, e.g. `tenant_acme,public`. */
  searchPath: string[]
}

export interface PgSchemaConnectionOptions {
  /**
   * Schemas searched after the tenant's: where database-wide objects live
   * (extensions such as pgcrypto or pg_trgm, text-search configurations).
   * Default `['public']`. `[]` keeps the tenant's schema alone on the path.
   */
  fallback?: string[]
}

/** A bare PostgreSQL identifier: what `tenantSchema()` produces, and safe in a search_path without quoting. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const PG_MAX_IDENTIFIER = 63

function assertIdentifier(name: string, what: string): void {
  if (!IDENTIFIER.test(name) || name.length > PG_MAX_IDENTIFIER) {
    throw new PgSchemaConnectionError(
      `${what} "${name}" is not a plain PostgreSQL identifier ([a-z_][a-z0-9_]*, at most ${PG_MAX_IDENTIFIER} characters)`,
    )
  }
}

/**
 * Turns a URL carrying `?schema=<name>` (what `schemaPerTenant` builds) into
 * the connection a client needs to run inside that schema.
 *
 * Fails closed: a URL without `?schema=` throws instead of connecting to
 * `public`, and so does a schema that is not a plain identifier.
 */
export function pgSchemaConnection(url: string, options: PgSchemaConnectionOptions = {}): PgSchemaConnection {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PgSchemaConnectionError('the connection URL could not be parsed')
  }
  const schema = parsed.searchParams.get('schema')
  if (!schema) {
    throw new PgSchemaConnectionError('the connection URL has no ?schema= — refusing to connect a tenant to the default schema')
  }
  assertIdentifier(schema, 'schema')
  const fallback = options.fallback ?? ['public']
  for (const name of fallback) assertIdentifier(name, 'fallback schema')
  const searchPath = [schema, ...fallback.filter((name) => name !== schema)]

  parsed.searchParams.delete('schema')
  const setting = `-c search_path=${searchPath.join(',')}`
  const existing = parsed.searchParams.get('options')
  parsed.searchParams.set('options', existing ? `${existing} ${setting}` : setting)
  return { connectionString: parsed.toString(), schema, searchPath }
}

/**
 * A `schemaPerTenant.createClient` that applies the tenant's schema to the
 * connection, then lets `build` make the client from it:
 *
 * ```ts
 * import { PrismaPg } from '@prisma/adapter-pg'
 *
 * prismaPlugin({
 *   schemaPerTenant: {
 *     url: env.DATABASE_URL,
 *     createClient: pgSchemaClient(({ connectionString, schema }) =>
 *       new PrismaClient({ adapter: new PrismaPg({ connectionString }, { schema }) })),
 *   },
 * })
 * ```
 *
 * Basalt never builds the client itself, so a Prisma upgrade changes `build`
 * and nothing else.
 */
export function pgSchemaClient<TClient>(
  build: (connection: PgSchemaConnection) => TClient | Promise<TClient>,
  options: PgSchemaConnectionOptions = {},
): (url: string) => TClient | Promise<TClient> {
  return (url) => build(pgSchemaConnection(url, options))
}
