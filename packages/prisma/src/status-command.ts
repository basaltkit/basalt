import { execFile } from 'node:child_process'
import type { CommandDefinition } from './command.js'
import { describeDbError } from './describe-db-error.js'
import { resolveTarget, type MigrateTarget } from './migrate.js'
import { assertSchemaPerTenantSupported } from './schema.js'
import { redactCredentials } from './assert-migrated.js'

/** Where one migration plane stands, from `prisma migrate status`. */
export type MigrationState = 'up-to-date' | 'pending' | 'failed' | 'drift' | 'unmanaged' | 'error'

export interface MigrationStatus {
  state: MigrationState
  /** Migrations not yet applied (`pending` only). */
  pending?: number
  /** The relevant line(s) of Prisma's output, credentials redacted. */
  detail?: string
  /** What to run, when Basalt knows (see `describeDbError`). */
  fix?: string
}

/** Runs the Prisma CLI and hands back its combined output and exit code. Never rejects on a non-zero exit. */
export type PrismaCliRunner = (
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<{ output: string; exitCode: number }>

/** Default runner: `npx prisma …` with the given env. */
export const npxPrismaRunner: PrismaCliRunner = (args, env) =>
  new Promise((resolve) => {
    execFile('npx', args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code
      resolve({
        output: `${String(stdout)}\n${String(stderr)}`,
        exitCode: error ? (typeof code === 'number' ? code : 1) : 0,
      })
    })
  })

export interface PrismaStatusTarget {
  /** `prisma.config.ts` of this plane (`--config`). */
  configPath?: string
  /** `schema.prisma` of this plane (`--schema`). */
  schemaPath?: string
}

/** The argv for `prisma migrate status` on one plane. */
export function prismaStatusArgs(target: PrismaStatusTarget = {}): string[] {
  const args = ['prisma', 'migrate', 'status']
  if (target.configPath) args.push('--config', target.configPath)
  if (target.schemaPath) args.push('--schema', target.schemaPath)
  return args
}

const block = (output: string, heading: RegExp): string[] => {
  const match = heading.exec(output)
  if (!match) return []
  const lines: string[] = []
  for (const line of output.slice(match.index + match[0].length).split('\n').slice(1)) {
    if (!line.trim()) {
      if (lines.length > 0) break
      continue
    }
    lines.push(line.trim())
  }
  return lines
}

/**
 * Reads `prisma migrate status` output. Prisma has no machine-readable mode,
 * so this matches its documented sentences; anything unrecognised with a
 * non-zero exit is an `error` (never a silent "up to date").
 */
export function parseMigrateStatus(output: string, exitCode: number): MigrationStatus {
  const clean = redactCredentials(output)
  if (/Database schema is up to date/i.test(clean)) return { state: 'up-to-date' }
  const failed = block(clean, /Following migrations? ha(?:s|ve) failed:?/i)
  if (failed.length > 0) {
    return {
      state: 'failed',
      detail: failed.join(', '),
      fix: 'Inspect the failed migration, then `prisma migrate resolve --rolled-back <name>` (or --applied) and deploy again.',
    }
  }
  if (/migration history and the migrations table from your database are different|drift detected/i.test(clean)) {
    return {
      state: 'drift',
      detail: 'The migration history in the database differs from the migrations directory.',
      fix: 'Compare `prisma/migrations` with the `_prisma_migrations` table; never edit an applied migration.',
    }
  }
  if (/not managed by Prisma Migrate/i.test(clean)) {
    return {
      state: 'unmanaged',
      detail: 'The database has no migration history.',
      fix:
        'Baseline it: `prisma migrate resolve --applied <migration_name>` for each migration already reflected in the schema — or run `prisma migrate deploy` on an empty database.',
    }
  }
  const pending = block(clean, /Following migrations? ha(?:s|ve) not yet been applied:?/i)
  if (pending.length > 0) {
    return { state: 'pending', pending: pending.length, detail: pending.join(', '), fix: 'Run the migrations for this plane.' }
  }
  if (exitCode === 0) return { state: 'up-to-date' }
  const diagnosis = describeDbError(clean)
  const line = clean
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => /^Error|P\d{4}|error/i.test(entry))
  return {
    state: 'error',
    detail: (diagnosis?.cause ?? line ?? `prisma migrate status exited with ${exitCode}`).slice(0, 300),
    ...(diagnosis ? { fix: diagnosis.fix } : {}),
  }
}

export interface DbStatusCommandConfig {
  /**
   * The central plane: checked with the app's own Prisma config (and its
   * `DATABASE_URL`), or the given config/schema. `false` skips it. Default: `{}`.
   */
  central?: PrismaStatusTarget | false
  /** The tenant plane: every tenant's schema/database, read-only. */
  tenants?: PrismaStatusTarget & {
    /** Resolves the tenant ids (e.g. `() => source.list().then((t) => t.map((x) => x.id))`). */
    list: () => string[] | Promise<string[]>
    /** How each tenant's URL is derived — the same target `tenantMigrateCommand` uses. */
    target: MigrateTarget
    /** Tenants checked in parallel. Default: 5. */
    concurrency?: number
  }
  /** Override how the Prisma CLI is run (tests, a custom binary). Default: `npx prisma`. */
  run?: PrismaCliRunner
}

interface Row extends MigrationStatus {
  plane: 'central' | 'tenant'
  tenantId?: string
  schema?: string
}

const label = (state: MigrationStatus): string =>
  state.state === 'pending' ? `${state.pending} pending` : state.state.replace('-', ' ')

/**
 * Builds `basalt db:status` — register it via `commandsPlugin()`.
 *
 * Read-only: runs `prisma migrate status` for the central plane and for every
 * tenant (it never applies, provisions, baselines or grants anything), prints
 * one line per plane/tenant with the fix for whatever is wrong, and exits 1
 * when anything is not up to date — so it can gate a deploy in CI. `--json`
 * prints the report as JSON.
 */
export function dbStatusCommand(config: DbStatusCommandConfig = {}): CommandDefinition {
  return {
    name: 'db:status',
    description: 'Report migration status of the central database and every tenant (read-only; exits 1 on drift)',
    async handle({ io, flags }) {
      const run = config.run ?? npxPrismaRunner
      const rows: Row[] = []
      const check = async (target: PrismaStatusTarget, env: Record<string, string | undefined>) => {
        try {
          const { output, exitCode } = await run(prismaStatusArgs(target), env)
          return parseMigrateStatus(output, exitCode)
        } catch (error) {
          const diagnosis = describeDbError(error)
          return {
            state: 'error' as const,
            detail: redactCredentials(diagnosis?.cause ?? (error instanceof Error ? error.message : String(error))),
            ...(diagnosis ? { fix: diagnosis.fix } : {}),
          }
        }
      }

      if (config.central !== false) {
        rows.push({ plane: 'central', ...(await check(config.central ?? {}, {})) })
      }

      const tenants = config.tenants
      if (tenants) {
        if (tenants.target.mode === 'schema') assertSchemaPerTenantSupported(tenants.target.url)
        const ids = await tenants.list()
        const results: Row[] = new Array(ids.length)
        let cursor = 0
        const worker = async (): Promise<void> => {
          while (cursor < ids.length) {
            const index = cursor++
            const tenantId = ids[index]!
            const { url, schema } = resolveTarget(tenants.target, tenantId)
            const status = await check(tenants, { DATABASE_URL: url })
            results[index] = { plane: 'tenant', tenantId, ...(schema ? { schema } : {}), ...status }
          }
        }
        await Promise.all(
          Array.from({ length: Math.min(Math.max(1, tenants.concurrency ?? 5), ids.length) }, worker),
        )
        rows.push(...results)
      }

      const ok = rows.every((row) => row.state === 'up-to-date')
      if (flags['json'] === true) {
        io.log(JSON.stringify({ ok, planes: rows }, null, 2))
        return ok ? 0 : 1
      }
      if (rows.length === 0) {
        io.log('Nothing to check: no central plane and no tenants configured.')
        return 0
      }
      for (const row of rows) {
        const name =
          row.plane === 'central' ? 'central' : `tenant ${row.tenantId}${row.schema ? ` (${row.schema})` : ''}`
        io.log(`${row.state === 'up-to-date' ? 'ok  ' : 'FAIL'} ${name}: ${label(row)}${row.detail && row.state !== 'up-to-date' ? ` — ${row.detail}` : ''}`)
        if (row.fix && row.state !== 'up-to-date') io.log(`       fix: ${row.fix}`)
      }
      const tenantRows = rows.filter((row) => row.plane === 'tenant')
      const behind = tenantRows.filter((row) => row.state !== 'up-to-date').length
      io.log(
        `${ok ? 'All up to date.' : 'Not up to date.'}` +
          (tenants ? ` Tenants: ${tenantRows.length - behind} up to date, ${behind} not.` : ''),
      )
      return ok ? 0 : 1
    },
  }
}
