import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { provisionTenantSchema, schemaUrl, tenantSchema, type SchemaProvisioner, assertSchemaPerTenantSupported } from './schema.js'

const execFileAsync = promisify(execFile)

export interface TenantMigrationResult {
  tenantId: string
  /** The connection URL used (schema- or database-scoped). */
  url: string
  schema?: string
  ok: boolean
  /** Error message when `ok` is false. */
  error?: string
}

/** How each tenant's migration target is derived. */
export type MigrateTarget =
  | {
      mode: 'schema'
      /** Base connection URL; the `schema` param is set per tenant. */
      url: string
      prefix?: string
      /** When set, runs CREATE SCHEMA IF NOT EXISTS before migrating. */
      provision?: SchemaProvisioner
    }
  | {
      mode: 'database'
      urlFor: (tenantId: string) => string
    }

export type MigrateFn = (info: {
  tenantId: string
  url: string
  schema?: string
}) => Promise<void>

export interface MigrateTenantsOptions {
  tenants: string[]
  target: MigrateTarget
  /** Runs the migration for one tenant. Default: prismaMigrator(). */
  migrate?: MigrateFn
  /** Max tenants migrated in parallel. Default: 5. */
  concurrency?: number
  /** Called as each tenant finishes (for progress output). */
  onResult?: (result: TenantMigrationResult) => void
}

/**
 * Runs migrations for every tenant, with bounded concurrency. A failing tenant
 * is reported (`ok: false`) but never aborts the others — the result array is
 * the per-tenant report the RFC calls for.
 */
export async function migrateTenants(
  options: MigrateTenantsOptions,
): Promise<TenantMigrationResult[]> {
  const { tenants, target } = options
  // Checked ONCE, before any worker starts. In schema mode every tenant shares
  // the same base URL, so an unsupported database is a configuration error for
  // the whole run — not a per-tenant failure to be collected N times. This is
  // therefore the one thing that legitimately aborts `migrateTenants`.
  if (target.mode === 'schema') assertSchemaPerTenantSupported(target.url)
  const migrate = options.migrate ?? prismaMigrator()
  const concurrency = Math.max(1, options.concurrency ?? 5)
  const results: TenantMigrationResult[] = new Array(tenants.length)

  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < tenants.length) {
      const index = cursor++
      const tenantId = tenants[index] as string
      const { url, schema } = resolveTarget(target, tenantId)
      const result: TenantMigrationResult = {
        tenantId,
        url,
        ...(schema ? { schema } : {}),
        ok: false,
      }
      try {
        if (target.mode === 'schema' && target.provision && schema) {
          await provisionTenantSchema(target.provision, schema)
        }
        await migrate({ tenantId, url, ...(schema ? { schema } : {}) })
        result.ok = true
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
      }
      results[index] = result
      options.onResult?.(result)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tenants.length) }, worker))
  return results
}

function resolveTarget(
  target: MigrateTarget,
  tenantId: string,
): { url: string; schema?: string } {
  if (target.mode === 'schema') {
    const schema = tenantSchema(tenantId, target.prefix ? { prefix: target.prefix } : {})
    return { url: schemaUrl(target.url, schema), schema }
  }
  return { url: target.urlFor(tenantId) }
}

export interface PrismaMigratorOptions {
  /** Path to schema.prisma, if not the default location. */
  schemaPath?: string
  /**
   * Path to a `prisma.config.ts` (`--config`). Use this when the tenant
   * migrations live somewhere other than the central `migrations` directory.
   *
   * `schemaPath` alone cannot express that: `migrations.path` is a property of
   * the *config*, not of the schema, so Prisma keeps reading the central
   * migration history even when `--schema` points at the tenant models. The
   * result is a tenant database that gets `_prisma_migrations` and none of the
   * tables. Point `configPath` at a config that pins both.
   *
   * Two Prisma behaviours worth knowing, because neither is guessable:
   * paths inside a config file resolve against **that file's own directory**,
   * not the project root; and a loaded config makes Prisma skip its usual `.env`
   * loading, so the config must read its URL from the environment (this
   * migrator always sets `DATABASE_URL` for the tenant).
   */
  configPath?: string
  /** Extra env for the child process. */
  env?: Record<string, string>
}

/**
 * Default migrator: shells out to `prisma migrate deploy` with the tenant's
 * URL as DATABASE_URL. Not exercised in unit tests (needs the Prisma CLI and a
 * live database) — the orchestration around it is what's tested.
 */
export function prismaMigrator(options: PrismaMigratorOptions = {}): MigrateFn {
  return async ({ url }) => {
    await execFileAsync('npx', prismaMigrateArgs(options), {
      env: { ...process.env, ...options.env, DATABASE_URL: url },
    })
  }
}

/**
 * The argv `prismaMigrator` shells out with. Split out so the flag wiring is
 * unit-testable without a Prisma CLI or a live database.
 */
export function prismaMigrateArgs(options: PrismaMigratorOptions = {}): string[] {
  const args = ['prisma', 'migrate', 'deploy']
  if (options.configPath) args.push('--config', options.configPath)
  if (options.schemaPath) args.push('--schema', options.schemaPath)
  return args
}
