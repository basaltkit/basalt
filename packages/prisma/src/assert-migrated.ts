import { BasaltError } from '@basaltkit/core'

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
}

export class DatabaseNotMigratedError extends BasaltError {
  constructor(message: string) {
    super('PRISMA_NOT_MIGRATED', message)
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

/** Best effort: which database/host did we actually reach? */
async function identify(client: RawQueryClient): Promise<Identity> {
  const describe = (row: Record<string, unknown> | undefined): string | undefined => {
    if (!row || row['database'] == null) return undefined
    const host = row['host'] == null ? 'a local socket' : String(row['host'])
    const port = row['port'] == null || row['host'] == null ? '' : `:${String(row['port'])}`
    return `database "${String(row['database'])}" on ${host}${port}`
  }
  try {
    const label = describe(
      first(
        await client.$queryRawUnsafe(
          'SELECT current_database() AS database, host(inet_server_addr()) AS host, inet_server_port() AS port',
        ),
      ),
    )
    if (label) return { dialect: 'postgres', label }
  } catch {
    // not Postgres (or no permission) — try MySQL
  }
  try {
    const label = describe(
      first(await client.$queryRawUnsafe('SELECT DATABASE() AS `database`, @@hostname AS host, @@port AS port')),
    )
    if (label) return { dialect: 'mysql', label }
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
      throw new DatabaseNotMigratedError(
        `Could not verify that ${identity.label} is migrated (assertMigrated): ${reason}`,
      )
    }
  }
  if (missing.length === 0) return
  const hint =
    'Check DATABASE_URL (a shell may have exported another project\'s) and run `prisma migrate deploy`.'
  if (missing[0] === '_prisma_migrations') {
    const others = missing.slice(1)
    throw new DatabaseNotMigratedError(
      `${capitalize(identity.label)} has no _prisma_migrations table — it was never migrated, or this is ` +
        `the wrong database.${others.length ? ` Also missing: ${others.join(', ')}.` : ''} ${hint}`,
    )
  }
  throw new DatabaseNotMigratedError(
    `${capitalize(identity.label)} is missing expected tables: ${missing.join(', ')}. ${hint}`,
  )
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
