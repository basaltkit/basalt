import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CommandDefinition } from './command.js'

/** The @basalt domains that ship a Prisma reference schema. */
const DOMAINS = ['auth', 'teams', 'subscriptions', 'permissions', 'comments', 'audit', 'activity', 'notifications', 'tenancy', 'events', 'webhooks', 'files']

export interface PrismaSyncTarget {
  /** Where this target's models are written. */
  schemaPath: string
  /** The domains that belong in it. */
  domains: string[]
}

export interface PrismaSyncCommandOptions {
  /** App schema path. Default: `prisma/schema.prisma`. Override with `--schema`. */
  schemaPath?: string
  /** Restrict discovery to these domains (else: every installed `*-prisma`). */
  domains?: string[]
  /**
   * Two or more schemas, each with the domains that belong in it.
   *
   * `DOMAINS` mixes domains that live in every tenant's schema (`auth`,
   * `permissions`, `audit`, `activity`, `teams`, `notifications`) with domains
   * that live only in the central one (`tenancy`, `subscriptions`). Nothing in
   * a package says which is which — placement is a decision of the application,
   * and until now the command had no way to be told.
   *
   * So `prisma:sync --yes`, the obvious invocation, wrote `Tenant`,
   * `Subscription` and `Payment` into the schema of every tenant. Those tables
   * must never hold a row, and having them there is a place for one tenant's
   * data to land unnoticed.
   *
   * ```ts
   * prismaSyncCommand({
   *   targets: {
   *     central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy', 'subscriptions'] },
   *     tenant: { schemaPath: 'prisma/tenants/schema.prisma', domains: ['auth', 'permissions'] },
   *   },
   * })
   * ```
   *
   * Without it the command behaves exactly as before — one schema, one list.
   */
  targets?: Record<string, PrismaSyncTarget>
}

interface SchemaBlock {
  kind: 'model' | 'enum'
  name: string
  text: string
}

/** Extract top-level `model`/`enum` blocks (Prisma bodies have no nested braces). */
export function extractSchemaBlocks(schema: string): SchemaBlock[] {
  const blocks: SchemaBlock[] = []
  const header = /^(model|enum)\s+(\w+)\s*\{/gm
  let match: RegExpExecArray | null
  while ((match = header.exec(schema)) !== null) {
    const start = match.index
    let depth = 0
    let end = -1
    for (let i = schema.indexOf('{', start); i < schema.length; i++) {
      if (schema[i] === '{') depth++
      else if (schema[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    if (end === -1) continue
    blocks.push({ kind: match[1] as 'model' | 'enum', name: match[2] as string, text: schema.slice(start, end + 1) })
    header.lastIndex = end + 1
  }
  return blocks
}

/** The `provider` of the schema's `datasource` block, if it names one literally. */
export function datasourceProvider(schema: string): string | undefined {
  const block = /^\s*datasource\s+\w+\s*\{([^}]*)\}/m.exec(schema)
  return block ? /\bprovider\s*=\s*"([^"]+)"/.exec(block[1] as string)?.[1] : undefined
}

interface DiscoveredSchema {
  pkg: string
  domain: string
  schema: string
  /** True when a MySQL app got the generic schema: the package ships no MySQL variant. */
  generic: boolean
}

/**
 * Locate installed `@basaltkit/<domain>-prisma` reference schemas, resolved from
 * the app root. A MySQL app gets the package's `schema.mysql.prisma` when it
 * ships one: a bare `String` is VARCHAR(191) on MySQL, and outside strict mode a
 * longer value is truncated silently, so the MySQL variant widens the free-text
 * columns.
 */
function discoverSchemas(domains: string[], provider?: string): DiscoveredSchema[] {
  // Resolve from the user's project (cwd), not this package — pnpm isolates deps.
  const requireFromApp = createRequire(pathToFileURL(join(process.cwd(), 'noop.js')))
  const found: DiscoveredSchema[] = []
  for (const domain of domains) {
    const pkg = `@basaltkit/${domain}-prisma`
    if (provider === 'mysql') {
      try {
        const schemaPath = requireFromApp.resolve(`${pkg}/schema.mysql.prisma`)
        found.push({ pkg, domain, schema: readFileSync(schemaPath, 'utf8'), generic: false })
        continue
      } catch {
        // no MySQL variant (or not installed) — fall through to the generic one
      }
    }
    try {
      const schemaPath = requireFromApp.resolve(`${pkg}/schema.prisma`)
      found.push({ pkg, domain, schema: readFileSync(schemaPath, 'utf8'), generic: provider === 'mysql' })
    } catch {
      // not installed — skip
    }
  }
  return found
}

/**
 * The `prisma.config.ts` of one plane: its own schema and its own migration
 * history, both relative to the config's directory (Prisma resolves config
 * paths against the file, not the project root).
 */
export function planeConfigTs(schemaFile: string): string {
  return `import { defineConfig, env } from 'prisma/config'

// One plane, one config: this schema and ONLY this plane's migration history.
// Paths are relative to this file's directory. Migrate with
// \`prisma migrate dev --config <this file>\`; tenants via tenant:migrate
// (prismaMigrator({ configPath })), which sets DATABASE_URL per tenant.
export default defineConfig({
  schema: '${schemaFile}',
  migrations: { path: 'migrations' },
  datasource: { url: env('DATABASE_URL') },
})
`
}

/**
 * A root `prisma.config.ts` that only serves `prisma generate`: no migrations
 * and no datasource, so a reflexive `prisma migrate dev` at the root fails
 * (Prisma 7 needs `datasource.url` from the config) instead of diffing both
 * planes into one database.
 */
export function generateOnlyRootConfigTs(schema: string): string {
  return `import { defineConfig } from 'prisma/config'

// Generate-only: no \`migrations\`, no \`datasource\`. Each plane migrates
// with its own config (--config), so \`prisma migrate dev\` here refuses to
// run instead of recreating tenant tables in the central database.
export default defineConfig({
  schema: '${schema}',
})
`
}

/**
 * With declared targets: every plane needs its own `prisma.config.ts`, and a
 * root config that can migrate is how tenant tables end up in the central
 * database. Prints (or, with `--yes`, writes) the missing plane configs, and
 * warns about a root config that declares migrations or a datasource. Never
 * overwrites an existing file.
 */
function checkPlaneConfigs(
  targets: Record<string, PrismaSyncTarget>,
  io: { log(m: string): void },
  write: boolean,
): void {
  const root = resolve('prisma.config.ts')
  const planeConfigs = new Set<string>()
  for (const [name, target] of Object.entries(targets)) {
    const schemaPath = resolve(target.schemaPath)
    const configPath = join(dirname(schemaPath), 'prisma.config.ts')
    planeConfigs.add(configPath)
    // The plane's schema sits at the project root: its config is the root one.
    if (configPath === root) continue
    const content = planeConfigTs(basename(schemaPath))
    if (write) {
      try {
        // 'wx': create only — an existing config is the app's, never ours to replace.
        writeFileSync(configPath, content, { flag: 'wx' })
        io.log(`[${name}] Wrote ${relative(process.cwd(), configPath)}: this plane's schema and migration history.`)
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'EEXIST') throw error
      }
      continue
    }
    let exists = true
    try {
      readFileSync(configPath)
    } catch {
      exists = false
    }
    if (exists) continue
    io.log(
      `[${name}] No prisma.config.ts next to ${relative(process.cwd(), schemaPath)}. Each plane needs its own ` +
        `(re-run with --yes to write it) — ${relative(process.cwd(), configPath)}:`,
    )
    io.log(content)
  }

  if (Object.keys(targets).length < 2 || planeConfigs.has(root)) return
  let rootText: string
  try {
    rootText = readFileSync(root, 'utf8')
  } catch {
    return
  }
  if (!/\bmigrations\s*:|\bdatasource\s*:/.test(rootText)) return
  const schema = /\bschema\s*:\s*['"`]([^'"`]+)['"`]/.exec(rootText)?.[1] ?? 'prisma/schema.prisma'
  io.log(
    `! prisma.config.ts at the project root declares migrations or a datasource while ${Object.keys(targets).length} ` +
      "planes are declared: `prisma migrate dev` there can recreate one plane's tables in the other database. " +
      'Make it generate-only (not changed for you):',
  )
  io.log(generateOnlyRootConfigTs(schema))
}

/**
 * Builds the `basalt prisma:sync` command: merges the models each installed
 * `@basaltkit/*-prisma` package needs into your `prisma/schema.prisma`.
 *
 * Interactive by default (asks per package). Flags:
 * - `--yes` / `--all` — non-interactive; add every installed package's models.
 * - `--only=auth,teams` — restrict to these domains.
 * - `--push` — run `prisma db push` after; `--migrate` runs `prisma migrate dev`.
 * - `--schema=<path>` — override the schema path.
 */
export function prismaSyncCommand(options: PrismaSyncCommandOptions = {}): CommandDefinition {
  return {
    name: 'prisma:sync',
    description: 'Merge @basaltkit/*-prisma models into your prisma/schema.prisma',
    async handle({ io, flags }) {
      const targets = options.targets

      if (targets && typeof flags['schema'] === 'string') {
        // `--schema` names one file; with several declared it cannot mean
        // anything. Picking one would write central models into it — the very
        // mistake `targets` exists to stop.
        io.error('--schema cannot be used with declared targets: it names one schema, and there are several.')
        io.error(`Declared: ${Object.keys(targets).join(', ')}. Use --only to narrow by domain instead.`)
        return 1
      }

      const requested =
        typeof flags['only'] === 'string' ? flags['only'].split(',').map((d) => d.trim()) : null

      /** One schema file: read it, add what is missing, write it back. */
      const syncOne = async (
        nome: string | null,
        schemaPath: string,
        domains: string[],
      ): Promise<number | null> => {
        const path = resolve(schemaPath)

        // Read first and ask questions after, rather than `existsSync` then
        // read: the two-step version has a window between the check and the
        // read, and answers a question the read itself already answers.
        let userSchema: string
        try {
          userSchema = readFileSync(path, 'utf8')
        } catch {
          io.error(`No schema found at ${path}.`)
          io.error('Create one first with a `datasource` and `generator` block, then re-run.')
          return null
        }
        const present = new Set(extractSchemaBlocks(userSchema).map((b) => b.name))
        const provider = datasourceProvider(userSchema)
        const packages = discoverSchemas(domains, provider)
        if (packages.length === 0) return 0

        const nonInteractive = flags['yes'] === true || flags['all'] === true
        const additions: string[] = []
        let added = 0
        const label = nome ? `[${nome}] ` : ''

        const mysqlPackages: string[] = []
        for (const { pkg, schema, generic } of packages) {
          const missing = extractSchemaBlocks(schema).filter((b) => !present.has(b.name))
          if (missing.length === 0) continue
          const names = missing.map((b) => b.name).join(', ')
          const approved =
            nonInteractive ||
            (await io.confirm(`${label}Add ${missing.length} model(s) from ${pkg} — ${names}?`))
          if (!approved) {
            io.log(`  ${label}skipped ${pkg}`)
            continue
          }
          additions.push(`\n// --- ${pkg} ---\n${missing.map((b) => b.text).join('\n\n')}`)
          missing.forEach((b) => present.add(b.name))
          added += missing.length
          io.log(`  ${label}+ ${pkg}: ${names}`)
          if (provider === 'mysql') {
            if (generic) {
              io.log(
                `    ${label}! ${pkg} ships no MySQL variant: its String columns are VARCHAR(191) — ` +
                  'upgrade it (every current @basaltkit/*-prisma ships schema.mysql.prisma) or widen ' +
                  'free-text columns with @db.Text before migrating.',
              )
            } else mysqlPackages.push(pkg)
          }
        }
        if (mysqlPackages.length > 0) {
          io.log(
            `  ${label}MySQL: used the schema.mysql.prisma variants. Also pass \`{ columnLimits: 'mysql' }\` ` +
              `to the stores of ${mysqlPackages.join(', ')} so an over-long value is refused, not truncated.`,
          )
        }

        if (added === 0) return 0
        writeFileSync(path, `${userSchema.replace(/\s*$/, '')}\n${additions.join('\n')}\n`)
        io.log(`${label}Added ${added} model(s) to ${path}.`)
        return added
      }

      let total = 0
      const escritos: string[] = []

      if (targets) {
        for (const [nome, target] of Object.entries(targets)) {
          // `--only` narrows inside each target; it never moves a domain across
          // one. Asking for `auth` must not drag in whatever shares its schema.
          const domains = requested
            ? target.domains.filter((d) => requested.includes(d))
            : target.domains
          if (domains.length === 0) continue

          const n = await syncOne(nome, target.schemaPath, domains)
          if (n === null) return 1
          if (n > 0) {
            total += n
            escritos.push(resolve(target.schemaPath))
          }
        }
      } else {
        const schemaPath =
          typeof flags['schema'] === 'string' ? flags['schema'] : (options.schemaPath ?? 'prisma/schema.prisma')
        const domains = requested ?? options.domains ?? DOMAINS

        const n = await syncOne(null, schemaPath, domains)
        if (n === null) return 1
        if (n === 0 && discoverSchemas(domains).length === 0) {
          io.log('No installed @basaltkit/*-prisma packages found. Add one (e.g. `@basaltkit/auth-prisma`) first.')
          return 0
        }
        total = n
        if (n > 0) escritos.push(resolve(schemaPath))
      }

      if (targets) checkPlaneConfigs(targets, io, flags['yes'] === true || flags['all'] === true)

      if (total === 0) {
        io.log('Schema is already up to date — nothing to add.')
        return 0
      }

      if (flags['migrate'] === true || flags['push'] === true) {
        const args = flags['migrate'] === true ? ['migrate', 'dev', '--name', 'basalt-sync'] : ['db', 'push']
        // Once per schema that actually changed. Running it against a schema
        // nothing was added to is a migration with no diff — noise in the
        // history at best, a surprise at worst.
        for (const path of escritos) {
          io.log(`Running: prisma ${args.join(' ')} --schema ${path}`)
          const result = spawnSync('npx', ['prisma', ...args, '--schema', path], { stdio: 'inherit' })
          if (result.status !== 0) {
            io.error('prisma command failed.')
            return result.status ?? 1
          }
        }
      } else {
        io.log('Next: `npx prisma db push` (or `migrate dev`) to apply, and `prisma generate`.')
      }
      return 0
    },
  }
}
