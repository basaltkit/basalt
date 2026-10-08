import { BasaltError } from '@basaltkit/core'
import { describeDbError, type DbErrorDiagnosis } from './describe-db-error.js'

/**
 * Boot-time check that the configured database is the migrated one.
 *
 * Booting against the wrong database otherwise passes silently — a shell that
 * exported another project's DATABASE_URL, a typo in the database name — and
 * the app only fails on its first request, with a P2021 "table does not exist"
 * far from the cause. This check fails the boot instead, naming the database
 * and host it actually reached (never the credentials).
 */

export interface AssertMigratedOptions {
  /**
   * Tables that must also exist (as named in the database: `@@map` names, or
   * the model name for unmapped models — case-sensitive). `schema.table` is
   * accepted. Default: only `_prisma_migrations` is checked.
   */
  tables?: string[]
  /**
   * Tables that must NOT exist here — the other plane's. With a schema (or a
   * database) per tenant, a root `prisma migrate dev` that diffs both planes
   * recreates every tenant table in the central database: empty, unreachable,
   * and a place for a stray write to land. Listing the tenant tables here
   * (`auth_users`, `team_memberships`, …) makes the boot refuse such a
   * database with `DatabasePlaneMixedError` (`PRISMA_PLANE_MIXED`) naming
   * them. Same name rules as `tables`; checked the same way, so it works on
   * PostgreSQL, MySQL and SQLite. Default: none.
   */
  forbiddenTables?: string[]
}

/**
 * The boot check failed. The code stays `PRISMA_NOT_MIGRATED` whatever the
 * reason; `details.diagnosis` (see `describeDbError`) says which one it was —
 * `DB_NOT_MIGRATED`, `DB_PERMISSION_DENIED`, `DB_UNREACHABLE` — with its fix.
 */
export class DatabaseNotMigratedError extends BasaltError {
  constructor(message: string, diagnosis?: DbErrorDiagnosis) {
    super('PRISMA_NOT_MIGRATED', message, diagnosis ? { details: { diagnosis: { ...diagnosis } } } : undefined)
  }
}

/**
 * The database holds tables of the other plane (`assertMigrated({ forbiddenTables })`):
 * typically tenant tables recreated in the central database by a root-level
 * `prisma migrate dev`. `details.tables` lists them.
 */
export class DatabasePlaneMixedError extends BasaltError {
  constructor(message: string, tables: string[]) {
    super('PRISMA_PLANE_MIXED', message, { details: { tables: [...tables] } })
  }
}

/** The raw-query surface this check needs (any Prisma client has it). */
interface RawQueryClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): PromiseLike<unknown>
}

const TABLE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/

type Dialect = 'postgres' | 'mysql' | 'unknown'

interface Identity {
  dialect: Dialect
  label: string
  /** The role the client connected as, when the server said. */
  role?: string
}

/**
 * Masks the userinfo of any URL in a message (`scheme://user:pass@host` →
 * `scheme://***@host`): a driver error may echo the connection string.
 */
export function redactCredentials(text: string): string {
  // A linear scan instead of a regex: an unanchored scheme pattern backtracks
  // polynomially on long runs of scheme characters (CodeQL js/polynomial-redos).
  let out = ''
  let from = 0
  let sep = text.indexOf('://', from)
  while (sep !== -1) {
    let start = sep
    while (start > from && /[a-z0-9+.-]/i.test(text[start - 1]!)) start--
    const hasScheme = start < sep && /[a-z]/i.test(text[start]!)
    let end = sep + 3
    while (end < text.length && !/[\s/@]/.test(text[end]!)) end++
    if (hasScheme && text[end] === '@') {
      out += `${text.slice(from, sep + 3)}***@`
      from = end + 1
    } else {
      out += text.slice(from, sep + 3)
      from = sep + 3
    }
    sep = text.indexOf('://', from)
  }
  return out + text.slice(from)
}

const first = (rows: unknown): Record<string, unknown> | undefined =>
  Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined

const roleFrom = (rows: unknown): { role?: string } => {
  const role = first(rows)?.['role']
  // MySQL's CURRENT_USER() is `user@host`: the grant names the user part.
  return typeof role === 'string' && role ? { role: role.split('@')[0]! } : {}
}

/** Best effort: which database/host did we actually reach? */
async function identify(client: RawQueryClient): Promise<Identity> {
  const describe = (row: Record<string, unknown> | undefined): string | undefined => {
    if (!row || row['database'] == null) return undefined
    const host = row['host'] == null ? 'a local socket' : String(row['host'])
    const port = row['port'] == null || row['host'] == null ? '' : `:${String(row['port'])}`
    return `database "${String(row['database'])}" on ${host}${port}`
  }
  let rows: unknown
  try {
    const label = describe(
      first(
        (rows = await client.$queryRawUnsafe(
          'SELECT current_database() AS database, host(inet_server_addr()) AS host, inet_server_port() AS port, current_user AS role',
        )),
      ),
    )
    if (label) return { dialect: 'postgres', label, ...roleFrom(rows) }
  } catch {
    // not Postgres (or no permission) — try MySQL
  }
  try {
    const label = describe(
      first(
        (rows = await client.$queryRawUnsafe(
          'SELECT DATABASE() AS `database`, @@hostname AS host, @@port AS port, CURRENT_USER() AS role',
        )),
      ),
    )
    if (label) return { dialect: 'mysql', label, ...roleFrom(rows) }
  } catch {
    // unknown dialect: fall through to a generic label
  }
  return { dialect: 'unknown', label: 'the configured database' }
}

function quoteTable(name: string, dialect: Dialect): string {
  if (!TABLE.test(name)) {
    throw new DatabaseNotMigratedError(`Invalid table name "${name}" in assertMigrated.tables.`)
  }
  const q = dialect === 'mysql' ? '`' : '"'
  return name
    .split('.')
    .map((part) => `${q}${part}${q}`)
    .join('.')
}

/** `true` when a query error says the table does not exist (vs. any other failure). */
function isMissingTable(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown }
  if (e?.code === 'P2021') return true
  const driverCode = String(e?.meta?.code ?? '')
  if (driverCode === '42P01' || driverCode === '1146') return true
  return /does not exist|doesn't exist|no such table|Invalid object name/i.test(String(e?.message ?? ''))
}

/**
 * Throws {@link DatabaseNotMigratedError} unless `_prisma_migrations` (and
 * every table in `options.tables`) exists in the database `client` reaches.
 * The error names that database and host; credentials are never printed.
 */
export async function assertMigrated(client: RawQueryClient, options: AssertMigratedOptions = {}): Promise<void> {
  const identity = await identify(client)
  const tables = ['_prisma_migrations', ...(options.tables ?? [])]
  const missing: string[] = []
  for (const table of tables) {
    try {
      await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM ${quoteTable(table, identity.dialect)}`)
    } catch (error) {
      if (error instanceof DatabaseNotMigratedError) throw error
      if (isMissingTable(error)) {
        missing.push(table)
        continue
      }
      const reason = redactCredentials(error instanceof Error ? error.message : String(error))
      const diagnosis = describeDbError(error, identity.role ? { role: identity.role } : {})
      if (diagnosis?.code === 'DB_PERMISSION_DENIED') {
        // Not "could not verify": the database answered, and refused. Saying
        // so (with the GRANT) is the whole difference between a one-line fix
        // and a morning spent reading an adapter stack trace.
        throw new DatabaseNotMigratedError(
          `${capitalize(identity.label)} refused the migration check (assertMigrated): ${reason}. ` +
            `Fix: ${diagnosis.fix}`,
          diagnosis,
        )
      }
      throw new DatabaseNotMigratedError(
        `Could not verify that ${identity.label} is migrated (assertMigrated): ${reason}` +
          (diagnosis ? `. Fix: ${diagnosis.fix}` : ''),
        diagnosis,
      )
    }
  }
  if (missing.length === 0) {
    await assertNoForbiddenTables(client, identity, options.forbiddenTables ?? [])
    return
  }
  // PostgreSQL hides a schema the role has no USAGE on from the search_path:
  // the tables are there, but an unqualified lookup says "does not exist".
  // That is the classic aftermath of a recreated `public` (grants gone), and
  // "not migrated" would send you to run migrations that are already applied.
  if (identity.dialect === 'postgres') {
    const hidden = await schemaWithoutUsage(client, missing[0]!)
    if (hidden) {
      const diagnosis = describeDbError(`permission denied for schema ${hidden}`, identity.role ? { role: identity.role } : {})!
      throw new DatabaseNotMigratedError(
        `${capitalize(identity.label)} has ${missing[0]} in schema "${hidden}", but the connected role has no ` +
          `USAGE on that schema (assertMigrated). Fix: ${diagnosis.fix}`,
        diagnosis,
      )
    }
  }
  const hint =
    'Check DATABASE_URL (a shell may have exported another project\'s) and run `prisma migrate deploy`.'
  const diagnosis: DbErrorDiagnosis = {
    code: 'DB_NOT_MIGRATED',
    cause: `${capitalize(identity.label)} is missing: ${missing.join(', ')}.`,
    fix: hint,
  }
  if (missing[0] === '_prisma_migrations') {
    const others = missing.slice(1)
    throw new DatabaseNotMigratedError(
      `${capitalize(identity.label)} has no _prisma_migrations table — it was never migrated, or this is ` +
        `the wrong database.${others.length ? ` Also missing: ${others.join(', ')}.` : ''} ${hint}`,
      diagnosis,
    )
  }
  throw new DatabaseNotMigratedError(
    `${capitalize(identity.label)} is missing expected tables: ${missing.join(', ')}. ${hint}`,
    diagnosis,
  )
}

/** Throws {@link DatabasePlaneMixedError} when any of `tables` exists. */
async function assertNoForbiddenTables(client: RawQueryClient, identity: Identity, tables: string[]): Promise<void> {
  const present: string[] = []
  for (const table of tables) {
    const quoted = quoteTable(table, identity.dialect)
    try {
      await client.$queryRawUnsafe(`SELECT COUNT(*) AS count FROM ${quoted}`)
      present.push(table)
    } catch (error) {
      if (isMissingTable(error)) continue
      const reason = redactCredentials(error instanceof Error ? error.message : String(error))
      throw new DatabaseNotMigratedError(
        `Could not verify that ${identity.label} holds none of assertMigrated.forbiddenTables: ${reason}`,
        describeDbError(error, identity.role ? { role: identity.role } : {}),
      )
    }
  }
  if (present.length === 0) return
  throw new DatabasePlaneMixedError(
    `${capitalize(identity.label)} holds tables of the other plane: ${present.join(', ')}. ` +
      'A migration ran against the wrong plane — typically `prisma migrate dev` with a root config that ' +
      'reaches both schemas. Migrate each plane with its own prisma.config.ts, keep the root config ' +
      'generate-only, and drop these tables once you have checked they hold no rows.',
    present,
  )
}

/** A schema holding `table` that the current role cannot use, if any (pg_catalog is readable by everyone). */
async function schemaWithoutUsage(client: RawQueryClient, table: string): Promise<string | undefined> {
  const name = table.includes('.') ? table.split('.').pop()! : table
  try {
    const row = first(
      await client.$queryRawUnsafe(
        'SELECT n.nspname AS schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ' +
          "WHERE c.relname = $1 AND NOT has_schema_privilege(n.oid, 'USAGE') LIMIT 1",
        name,
      ),
    )
    return typeof row?.['schema'] === 'string' ? row['schema'] : undefined
  } catch {
    return undefined
  }
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
