/**
 * Postgres Row-Level Security (RLS) helpers — defense in depth for the
 * shared-database tenancy mode.
 *
 * The {@link tenancyExtension} scopes queries in the application layer. RLS adds
 * a second, database-enforced layer: even a query that forgets the tenant
 * predicate (a raw SQL statement, a hand-written report, a bug) cannot read or
 * write another tenant's rows, because the database itself filters them.
 *
 * Two pieces:
 *  1. {@link rlsPolicySql} — run once (migration) to enable RLS + a policy on
 *     each tenant table.
 *  2. {@link setTenantConfigSql} / {@link tenantConfigParams} — run per request,
 *     inside a transaction, to tell the database which tenant is active.
 *
 * Recommended wiring (per request):
 *
 *   await db.$transaction(async (tx) => {
 *     await tx.$executeRawUnsafe(setTenantConfigSql(), ...tenantConfigParams(tenantId))
 *     // ... all queries in here are RLS-filtered to `tenantId`
 *   })
 *
 * `set_config(..., true)` makes the setting transaction-local, so it can never
 * leak onto the next request that reuses the pooled connection.
 */

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
// A custom GUC must be namespaced: `app.tenant_id`, `basalt.tenant`, …
const SETTING = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/

/** Default Postgres setting (GUC) that carries the active tenant id. */
export const DEFAULT_TENANT_SETTING = 'app.tenant_id'

export interface RlsPolicyOptions {
  /** Tables to protect (unqualified names). */
  tables: string[]
  /** Column holding the tenant id. Default: 'tenant_id'. */
  tenantColumn?: string
  /** Postgres setting read for the active tenant. Default: 'app.tenant_id'. */
  setting?: string
  /** Policy name. Default: 'tenant_isolation'. */
  policyName?: string
  /** Optional schema qualifier for the tables. */
  schema?: string
  /**
   * Also enforce RLS for the table owner (FORCE ROW LEVEL SECURITY). Default:
   * true — important because apps usually connect as the table's owner, who
   * would otherwise bypass RLS.
   */
  force?: boolean
}

const quote = (ident: string, label: string): string => {
  if (!IDENTIFIER.test(ident)) {
    throw new Error(`Invalid ${label} "${ident}" — must match ${IDENTIFIER}.`)
  }
  return `"${ident}"`
}

/**
 * Idempotent SQL that enables RLS and installs a tenant-isolation policy on each
 * table. The policy restricts every row (read and write) to the tenant named by
 * the current `setting`. Safe to run repeatedly (drops+recreates the policy).
 */
export function rlsPolicySql(options: RlsPolicyOptions): string {
  const column = quote(options.tenantColumn ?? 'tenant_id', 'tenant column')
  const policy = quote(options.policyName ?? 'tenant_isolation', 'policy name')
  const setting = options.setting ?? DEFAULT_TENANT_SETTING
  if (!SETTING.test(setting)) {
    throw new Error(`Invalid setting "${setting}" — must be a namespaced GUC like "app.tenant_id".`)
  }
  const force = options.force ?? true
  const schemaPrefix = options.schema ? `${quote(options.schema, 'schema')}.` : ''
  // set_config-style read: current_setting('app.tenant_id', true) returns NULL
  // (not an error) when unset, so an unset session matches no rows — fail closed.
  const predicate = `${column} = current_setting('${setting}', true)`

  return options.tables
    .map((name) => {
      const table = `${schemaPrefix}${quote(name, 'table')}`
      return [
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
        force ? `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;` : '',
        `DROP POLICY IF EXISTS ${policy} ON ${table};`,
        `CREATE POLICY ${policy} ON ${table} USING (${predicate}) WITH CHECK (${predicate});`,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

/**
 * The parameterized statement that sets the active tenant for the current
 * transaction. Pair with {@link tenantConfigParams}. Fully parameterized — the
 * tenant id is never interpolated into SQL.
 */
export function setTenantConfigSql(): string {
  return 'select set_config($1, $2, true)'
}

/** Params for {@link setTenantConfigSql}: `[setting, tenantId]`. */
export function tenantConfigParams(tenantId: string, setting: string = DEFAULT_TENANT_SETTING): [string, string] {
  if (!SETTING.test(setting)) {
    throw new Error(`Invalid setting "${setting}" — must be a namespaced GUC like "app.tenant_id".`)
  }
  return [setting, tenantId]
}
