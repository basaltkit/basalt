import type { CommandDefinition } from './command.js'
import { migrateTenants, prismaMigrator, type MigrateFn, type MigrateTarget } from './migrate.js'

export interface TenantMigrateCommandConfig {
  /** Resolves the tenant ids to migrate (e.g. `() => source.list().then(...)`). */
  tenants: () => string[] | Promise<string[]>
  target: MigrateTarget
  /** Override the migrator (default: prismaMigrator()). */
  migrate?: MigrateFn
  concurrency?: number
}

/**
 * Builds the `basalt tenant:migrate` command — register it via commandsPlugin().
 * Runs migrations for every tenant, prints a per-tenant report, and exits
 * non-zero if any tenant failed.
 */
export function tenantMigrateCommand(config: TenantMigrateCommandConfig): CommandDefinition {
  return {
    name: 'tenant:migrate',
    description: 'Run database migrations for every tenant',
    async handle({ io }) {
      const tenants = await config.tenants()
      if (tenants.length === 0) {
        io.log('No tenants to migrate.')
        return 0
      }

      io.log(`Migrating ${tenants.length} tenant(s)...`)
      const results = await migrateTenants({
        tenants,
        target: config.target,
        migrate: config.migrate ?? prismaMigrator(),
        ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
        onResult: (result) => {
          const label = result.schema ? `${result.tenantId} (${result.schema})` : result.tenantId
          io.log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${label}${result.error ? ` — ${result.error}` : ''}`)
        },
      })

      const failed = results.filter((result) => !result.ok)
      io.log(`Done: ${results.length - failed.length} migrated, ${failed.length} failed.`)
      return failed.length > 0 ? 1 : 0
    },
  }
}
