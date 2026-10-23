import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type pg from 'pg'
import { prisma } from './db.js'

/**
 * The tenant migration runner a Basalt Prisma 8 package would own (RFC 0011 §4),
 * prototyped here. Prisma plans and attests the migration packages; Prisma's
 * `db migrate` cannot apply them per schema (one marker per database). This runner
 * applies one package to ONE tenant schema, in three layers:
 *
 * 1. Integrity — `prisma migration check <package>`: a package whose ops.json no
 *    longer matches its attested hash is refused. (Integrity, not authorship: anyone
 *    who can write the repository can re-attest; layers 2 and 3 do not trust it.)
 * 2. Validation of every operation, before anything runs:
 *    - `operationClass: "data"` (a TypeScript `dataTransform`, compiled to SQL when
 *      authored) is refused: it was written against one tenant's rows and contract;
 *    - an operation must name the tenant's schema as its target, except the two
 *      no-op `CREATE SCHEMA IF NOT EXISTS` steps a first migration plans;
 *    - every `execute` statement — the only SQL this runner runs; Prisma's
 *      precheck/postcheck queries are not executed — is ONE statement that starts
 *      with an allowed DDL command; nothing grants, changes roles or settings,
 *      creates functions, or touches policies/RLS;
 *    - every schema-qualified identifier in it is the tenant's, and no string
 *      parameter names another existing schema.
 * 3. PostgreSQL itself — the package runs inside one transaction under
 *    `SET LOCAL ROLE <schema>_owner`, a NOLOGIN role that owns only this schema.
 *    A statement that slipped past layer 2 still cannot touch another tenant (42501).
 *
 * The ledger (`<schema>._basalt_migrations`) records each package with its hash, in
 * the same transaction. Prisma's marker is never read or written.
 */

export interface Step { description?: string; sql: string; params?: unknown[] }
export interface Operation {
  id: string
  label?: string
  operationClass: string
  target?: { id?: string; details?: { schema?: string } | null }
  precheck?: Step[]
  execute?: Step[]
  postcheck?: Step[]
}

export class MigrationRejected extends Error {
  constructor(readonly migration: string, readonly reasons: string[]) {
    super(`migration ${migration} rejected: ${reasons.join('; ')}`)
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/
const EXECUTE_ALLOWED = /^\s*(CREATE\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|ALTER\s+TABLE|DROP\s+INDEX|DROP\s+TABLE|CREATE\s+TYPE|ALTER\s+TYPE|DROP\s+TYPE|COMMENT\s+ON|CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS)\b/i
const FORBIDDEN = /\b(GRANT|REVOKE|ROLE|SESSION_USER|SET\s+(LOCAL\s+)?[a-z_]+\s*(=|TO)|RESET|ALTER\s+SYSTEM|COPY|DO|FUNCTION|PROCEDURE|TRIGGER|SECURITY\s+DEFINER|POLICY|ROW\s+LEVEL\s+SECURITY|DROP\s+SCHEMA|EXTENSION|dblink|pg_read_file|lo_import)\b/i

export const ownerRole = (schema: string) => `${schema}_owner`

/** Layer 2: the reasons a package's operations may not run in `schema` (empty = allowed). */
export function validateOperations(schema: string, operations: Operation[], knownSchemas: readonly string[] = []): string[] {
  if (!IDENT.test(schema)) return [`"${schema}" is not a plain schema identifier`]
  const reasons: string[] = []
  const others = new Set(knownSchemas.filter((s) => s !== schema))
  const noOpSchema = (op: Operation, name: string) =>
    op.id === `schema.${name}` && (op.execute ?? []).length === 1 && op.execute![0]!.sql.trim() === `CREATE SCHEMA IF NOT EXISTS "${name}"`

  for (const op of operations) {
    const where = `operation ${op.id}`
    if (op.operationClass === 'data') {
      reasons.push(`${where}: a data transform (TypeScript dataTransform) cannot be replayed per tenant`)
      continue
    }
    if (noOpSchema(op, 'public') || noOpSchema(op, schema)) continue
    const target = op.target?.details?.schema
    if (target !== schema) reasons.push(`${where}: targets ${target ? `schema "${target}"` : 'no declared schema'}, not "${schema}"`)
    for (const step of op.execute ?? []) {
      const sql = step.sql.trim()
      if (sql.replace(/'(?:[^']|'')*'/g, "''").includes(';')) reasons.push(`${where}: execute holds more than one statement`)
      if (!EXECUTE_ALLOWED.test(sql)) reasons.push(`${where}: execute statement not allowed: ${sql.slice(0, 60)}`)
      if (FORBIDDEN.test(sql)) reasons.push(`${where}: execute uses a forbidden keyword: ${sql.slice(0, 60)}`)
      for (const m of sql.matchAll(/"([^"]+)"\s*\.\s*"/g)) {
        if (m[1] !== schema) reasons.push(`${where}: execute names schema "${m[1]}"`)
      }
      for (const p of step.params ?? []) if (typeof p === 'string' && others.has(p)) reasons.push(`${where}: execute parameter names another schema "${p}"`)
    }
  }
  return [...new Set(reasons)]
}

/**
 * The packages of one migrations/app directory in GRAPH order: from the package whose
 * `from` is null (or an unknown origin), following `to` → `from`. Directory names are
 * minute-stamped, so two packages planned in the same minute sort by name — `add_x`
 * before `init` — and name order would apply them out of order. A fork or a gap is
 * refused rather than guessed.
 */
export async function orderedPackages(root: string): Promise<string[]> {
  const nodes = await Promise.all(
    (await readdir(root).catch(() => [] as string[])).map(async (name) => {
      const m = JSON.parse(await readFile(join(root, name, 'migration.json'), 'utf8')) as { from: string | null; to: string }
      return { name, from: m.from, to: m.to }
    }),
  )
  if (nodes.length === 0) return []
  const tos = new Set(nodes.map((n) => n.to))
  const roots = nodes.filter((n) => n.from === null || !tos.has(n.from))
  if (roots.length !== 1) throw new MigrationRejected('-', [`expected one first migration, found ${roots.length}`])
  const byFrom = new Map<string, typeof nodes>()
  for (const n of nodes) if (n.from) byFrom.set(n.from, [...(byFrom.get(n.from) ?? []), n])
  const order = [roots[0]!]
  while (order.length < nodes.length) {
    const next = byFrom.get(order.at(-1)!.to) ?? []
    if (next.length !== 1) throw new MigrationRejected('-', [`the migration graph ${next.length === 0 ? 'has a gap' : 'forks'} after ${order.at(-1)!.name}`])
    order.push(next[0]!)
  }
  return order.map((n) => n.name)
}

/** Reads a package's attested operations. */
async function packageOperations(dir: string): Promise<Operation[]> {
  return JSON.parse(await readFile(join(dir, 'ops.json'), 'utf8')) as Operation[]
}

export interface RunOptions {
  /** Test-only: skip layers 1 and 2, to prove layer 3 holds on its own. */
  unsafeSkipValidation?: boolean
}

/** Applies the packages of `config`'s migrations/app that `schema` has not run yet. Returns their names. */
export async function migrateTenantSchema(admin: pg.Client, schema: string, config: string, options: RunOptions = {}): Promise<string[]> {
  if (!IDENT.test(schema)) throw new MigrationRejected('-', [`"${schema}" is not a plain schema identifier`])
  const role = ownerRole(schema)
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE "${role}" NOLOGIN; END IF; END $$`)
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${role}"`)
  await admin.query(`CREATE TABLE IF NOT EXISTS "${schema}"."_basalt_migrations" (name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await admin.query(`SELECT name FROM "${schema}"."_basalt_migrations"`)).rows.map((r: { name: string }) => r.name))
  const known = (await admin.query(`SELECT nspname FROM pg_namespace`)).rows.map((r: { nspname: string }) => r.nspname)
  const root = join(dirname(config), 'migrations', 'app')
  const applied: string[] = []

  for (const name of await orderedPackages(root)) {
    if (done.has(name)) continue
    const dir = join(root, name)
    const operations = await packageOperations(dir)
    const { migrationHash } = JSON.parse(await readFile(join(dir, 'migration.json'), 'utf8')) as { migrationHash: string }
    if (!options.unsafeSkipValidation) {
      const checked = await prisma(['migration', 'check', name], { config })
      const result = checked.result as { ok?: boolean; failures?: Array<{ code: string }> } | undefined
      if (!checked.ok || !result?.ok) throw new MigrationRejected(name, [`integrity check failed: ${(result?.failures ?? []).map((f) => f.code).join(', ') || 'unknown'}`])
      const reasons = validateOperations(schema, operations, known)
      if (reasons.length > 0) throw new MigrationRejected(name, reasons)
    }
    await admin.query('BEGIN')
    try {
      await admin.query(`SET LOCAL ROLE "${role}"`)
      await admin.query(`SET LOCAL search_path = "${schema}"`)
      for (const op of operations) {
        if (op.id === 'schema.public' || op.id === `schema.${schema}`) continue // created above, owned by the role
        for (const step of op.execute ?? []) await admin.query(step.sql, (step.params ?? []) as unknown[])
      }
      await admin.query('RESET ROLE')
      await admin.query(`INSERT INTO "${schema}"."_basalt_migrations" (name, hash) VALUES ($1, $2)`, [name, migrationHash])
      await admin.query('COMMIT')
    } catch (error) {
      await admin.query('ROLLBACK')
      throw error
    }
    applied.push(name)
  }
  return applied
}

/** Plans the next migration package from the last one on disk (Prisma asks for the origin explicitly). */
export async function planNext(config: string, name: string) {
  const root = join(dirname(config), 'migrations', 'app')
  const from = (await orderedPackages(root)).at(-1)
  return prisma(['migration', 'plan', '--name', name, ...(from ? ['--from', from] : [])], { config })
}

/**
 * Authors a migration by hand, the documented way (`prisma migration new`, then the
 * generated migration.ts run with Node to self-emit and attest ops.json). `body` is
 * the operations array source; `db` (a query builder over the end contract) and
 * `rawSql` are in scope.
 */
export async function authorMigration(config: string, name: string, body: string): Promise<string> {
  const root = join(dirname(config), 'migrations', 'app')
  const last = (await orderedPackages(root)).at(-1)!
  const { to } = JSON.parse(await readFile(join(root, last, 'migration.json'), 'utf8')) as { to: string }
  const created = await prisma(['migration', 'new', '--name', name, '--from', to], { config })
  if (!created.ok) throw new Error(`migration new failed: ${JSON.stringify(created)}`)
  const dir = join(root, (await readdir(root)).sort().find((d) => d.endsWith(`_${name}`))!)
  const { readFile: rf, writeFile } = await import('node:fs/promises')
  let source = await rf(join(dir, 'migration.ts'), 'utf8')
  source = source.replace(
    "import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';",
    `import { Migration, MigrationCLI, rawSql } from '@prisma/orm-postgres/migration';
import postgresAdapter from '@prisma/orm-postgres/adapter/runtime';
import { sql } from '@prisma/orm-postgres/builder/runtime';
import { createExecutionContext, createSqlExecutionStack } from '@prisma/orm-postgres/family-runtime';
import postgresTarget, { PostgresContractSerializer } from '@prisma/orm-postgres/target/runtime';
const endContractObj = new PostgresContractSerializer().deserializeContract<End>(endContract);
const stack = createSqlExecutionStack({ target: postgresTarget, adapter: postgresAdapter });
const db: any = sql<End>({ context: createExecutionContext({ contract: endContractObj, stack }), rawCodecInferer: stack.adapter.rawCodecInferer });`,
  )
  source = source.replace('    return [];', `    return ${body};`)
  await writeFile(join(dir, 'migration.ts'), source)
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)(process.execPath, [join(dir, 'migration.ts'), '--config', config], {
    cwd: dirname(config),
    env: { ...process.env },
  })
  return dir.split('/').at(-1)!
}
