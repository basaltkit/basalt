import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineCommand, type CommandDefinition } from '@machize/cli'

/** The @machize domains that ship a Prisma reference schema. */
const DOMAINS = ['auth', 'teams', 'subscriptions', 'permissions', 'comments', 'audit', 'activity', 'notifications']

export interface PrismaSyncCommandOptions {
  /** App schema path. Default: `prisma/schema.prisma`. Override with `--schema`. */
  schemaPath?: string
  /** Restrict discovery to these domains (else: every installed `*-prisma`). */
  domains?: string[]
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

/** Locate installed `@machize/<domain>-prisma` reference schemas, resolved from the app root. */
function discoverSchemas(domains: string[]): { pkg: string; domain: string; schema: string }[] {
  // Resolve from the user's project (cwd), not this package — pnpm isolates deps.
  const requireFromApp = createRequire(pathToFileURL(join(process.cwd(), 'noop.js')))
  const found: { pkg: string; domain: string; schema: string }[] = []
  for (const domain of domains) {
    const pkg = `@machize/${domain}-prisma`
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
 * Builds the `mach prisma:sync` command: merges the models each installed
 * `@machize/*-prisma` package needs into your `prisma/schema.prisma`.
 *
 * Interactive by default (asks per package). Flags:
 * - `--yes` / `--all` — non-interactive; add every installed package's models.
 * - `--only=auth,teams` — restrict to these domains.
 * - `--push` — run `prisma db push` after; `--migrate` runs `prisma migrate dev`.
 * - `--schema=<path>` — override the schema path.
 */
export function prismaSyncCommand(options: PrismaSyncCommandOptions = {}): CommandDefinition {
  return defineCommand({
    name: 'prisma:sync',
    description: 'Merge @machize/*-prisma models into your prisma/schema.prisma',
    async handle({ io, flags }) {
      const schemaPath = resolve(
        typeof flags['schema'] === 'string' ? flags['schema'] : (options.schemaPath ?? 'prisma/schema.prisma'),
      )
      if (!existsSync(schemaPath)) {
        io.error(`No schema found at ${schemaPath}.`)
        io.error('Create one first with a `datasource` and `generator` block, then re-run.')
        return 1
      }
      const userSchema = readFileSync(schemaPath, 'utf8')
      const present = new Set(extractSchemaBlocks(userSchema).map((b) => b.name))

      const onlyDomains =
        typeof flags['only'] === 'string' ? flags['only'].split(',').map((d) => d.trim()) : (options.domains ?? DOMAINS)
      const packages = discoverSchemas(onlyDomains)
      if (packages.length === 0) {
        io.log('No installed @machize/*-prisma packages found. Add one (e.g. `@machize/auth-prisma`) first.')
        return 0
      }

      const nonInteractive = flags['yes'] === true || flags['all'] === true
      const additions: string[] = []
      let added = 0

      for (const { pkg, schema } of packages) {
        const missing = extractSchemaBlocks(schema).filter((b) => !present.has(b.name))
        if (missing.length === 0) continue // already in the schema
        const names = missing.map((b) => b.name).join(', ')
        const approved = nonInteractive || (await io.confirm(`Add ${missing.length} model(s) from ${pkg} — ${names}?`))
        if (!approved) {
          io.log(`  skipped ${pkg}`)
          continue
        }
        additions.push(`\n// --- ${pkg} ---\n${missing.map((b) => b.text).join('\n\n')}`)
        missing.forEach((b) => present.add(b.name))
        added += missing.length
        io.log(`  + ${pkg}: ${names}`)
      }

      if (added === 0) {
        io.log('Schema is already up to date — nothing to add.')
        return 0
      }

      writeFileSync(schemaPath, `${userSchema.replace(/\s*$/, '')}\n${additions.join('\n')}\n`)
      io.log(`Added ${added} model(s) to ${schemaPath}.`)

      if (flags['migrate'] === true || flags['push'] === true) {
        const args = flags['migrate'] === true ? ['migrate', 'dev', '--name', 'machize-sync'] : ['db', 'push']
        io.log(`Running: prisma ${args.join(' ')}`)
        const result = spawnSync('npx', ['prisma', ...args, '--schema', schemaPath], { stdio: 'inherit' })
        if (result.status !== 0) {
          io.error('prisma command failed.')
          return result.status ?? 1
        }
      } else {
        io.log('Next: `npx prisma db push` (or `migrate dev`) to apply, and `prisma generate`.')
      }
      return 0
    },
  })
}
