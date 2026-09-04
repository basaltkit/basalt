import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
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

/** Locate installed `@basaltkit/<domain>-prisma` reference schemas, resolved from the app root. */
function discoverSchemas(domains: string[]): { pkg: string; domain: string; schema: string }[] {
  // Resolve from the user's project (cwd), not this package — pnpm isolates deps.
  const requireFromApp = createRequire(pathToFileURL(join(process.cwd(), 'noop.js')))
  const found: { pkg: string; domain: string; schema: string }[] = []
  for (const domain of domains) {
    const pkg = `@basaltkit/${domain}-prisma`
    try {
      const schemaPath = requireFromApp.resolve(`${pkg}/schema.prisma`)
      found.push({ pkg, domain, schema: readFileSync(schemaPath, 'utf8') })
    } catch {
      // not installed — skip
    }
  }
  return found
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
      const alvos = options.targets

      if (alvos && typeof flags['schema'] === 'string') {
        // `--schema` names one file; with several declared it cannot mean
        // anything. Picking one would write central models into it — the very
        // mistake `targets` exists to stop.
        io.error('--schema cannot be used with declared targets: it names one schema, and there are several.')
        io.error(`Declared: ${Object.keys(alvos).join(', ')}. Use --only to narrow by domain instead.`)
        return 1
      }

      const pedidos =
        typeof flags['only'] === 'string' ? flags['only'].split(',').map((d) => d.trim()) : null

      /** One schema file: read it, add what is missing, write it back. */
      const sincronizar = async (
        nome: string | null,
        schemaPath: string,
        dominios: string[],
      ): Promise<number | null> => {
        const caminho = resolve(schemaPath)

        // Read first and ask questions after, rather than `existsSync` then
        // read: the two-step version has a window between the check and the
        // read, and answers a question the read itself already answers.
        let userSchema: string
        try {
          userSchema = readFileSync(caminho, 'utf8')
        } catch {
          io.error(`No schema found at ${caminho}.`)
          io.error('Create one first with a `datasource` and `generator` block, then re-run.')
          return null
        }
        const present = new Set(extractSchemaBlocks(userSchema).map((b) => b.name))
        const packages = discoverSchemas(dominios)
        if (packages.length === 0) return 0

        const nonInteractive = flags['yes'] === true || flags['all'] === true
        const additions: string[] = []
        let added = 0
        const etiqueta = nome ? `[${nome}] ` : ''

        for (const { pkg, schema } of packages) {
          const missing = extractSchemaBlocks(schema).filter((b) => !present.has(b.name))
          if (missing.length === 0) continue
          const names = missing.map((b) => b.name).join(', ')
          const approved =
            nonInteractive ||
            (await io.confirm(`${etiqueta}Add ${missing.length} model(s) from ${pkg} — ${names}?`))
          if (!approved) {
            io.log(`  ${etiqueta}skipped ${pkg}`)
            continue
          }
          additions.push(`\n// --- ${pkg} ---\n${missing.map((b) => b.text).join('\n\n')}`)
          missing.forEach((b) => present.add(b.name))
          added += missing.length
          io.log(`  ${etiqueta}+ ${pkg}: ${names}`)
        }

        if (added === 0) return 0
        writeFileSync(caminho, `${userSchema.replace(/\s*$/, '')}\n${additions.join('\n')}\n`)
        io.log(`${etiqueta}Added ${added} model(s) to ${caminho}.`)
        return added
      }

      let total = 0
      const escritos: string[] = []

      if (alvos) {
        for (const [nome, alvo] of Object.entries(alvos)) {
          // `--only` narrows inside each target; it never moves a domain across
          // one. Asking for `auth` must not drag in whatever shares its schema.
          const dominios = pedidos
            ? alvo.domains.filter((d) => pedidos.includes(d))
            : alvo.domains
          if (dominios.length === 0) continue

          const n = await sincronizar(nome, alvo.schemaPath, dominios)
          if (n === null) return 1
          if (n > 0) {
            total += n
            escritos.push(resolve(alvo.schemaPath))
          }
        }
      } else {
        const schemaPath =
          typeof flags['schema'] === 'string' ? flags['schema'] : (options.schemaPath ?? 'prisma/schema.prisma')
        const dominios = pedidos ?? options.domains ?? DOMAINS

        const n = await sincronizar(null, schemaPath, dominios)
        if (n === null) return 1
        if (n === 0 && discoverSchemas(dominios).length === 0) {
          io.log('No installed @basaltkit/*-prisma packages found. Add one (e.g. `@basaltkit/auth-prisma`) first.')
          return 0
        }
        total = n
        if (n > 0) escritos.push(resolve(schemaPath))
      }

      if (total === 0) {
        io.log('Schema is already up to date — nothing to add.')
        return 0
      }

      if (flags['migrate'] === true || flags['push'] === true) {
        const args = flags['migrate'] === true ? ['migrate', 'dev', '--name', 'basalt-sync'] : ['db', 'push']
        // Once per schema that actually changed. Running it against a schema
        // nothing was added to is a migration with no diff — noise in the
        // history at best, a surprise at worst.
        for (const caminho of escritos) {
          io.log(`Running: prisma ${args.join(' ')} --schema ${caminho}`)
          const result = spawnSync('npx', ['prisma', ...args, '--schema', caminho], { stdio: 'inherit' })
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
