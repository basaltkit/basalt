import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defineCommand, type CommandDefinition } from '@basaltkit/cli'
import {
  FileExistsError,
  GENERATORS,
  generate,
  generateResource,
  registerResourceInApp,
  writeGenerated,
  type GeneratorKind,
  type GeneratorOptions,
} from './generate.js'

interface MakeSpec {
  command: string
  /** Emits routes and/or a repository, so auth/tenancy apply and the security note is printed. */
  secured?: boolean
  describe: string
  build: (name: string, options: GeneratorOptions) => Parameters<typeof writeGenerated>[0]
  /** After writing, wire the resource's plugin + routes into src/app.ts. */
  register?: boolean
}

function specs(): MakeSpec[] {
  return [
    {
      command: 'make:resource',
      describe: 'Generate a full resource vertical',
      build: (name, options) => generateResource(name, options),
      register: true,
      secured: true,
    },
    ...(Object.keys(GENERATORS) as GeneratorKind[]).map((kind) => ({
      command: `make:${kind}`,
      describe: `Generate a ${kind} file`,
      secured: kind === 'routes' || kind === 'repository' || kind === 'test',
      build: (name: string, options: GeneratorOptions) => [generate(kind, name, options)],
    })),
  ]
}

/** Packages whose presence marks the project as multi-tenant. */
const TENANCY_PACKAGES = /^@basaltkit\/tenancy(?:-[a-z0-9-]+)?$/

/**
 * Whether the project at `baseDir` depends on `@basaltkit/tenancy` (or one of
 * its drivers). An unreadable or missing package.json counts as "no".
 */
async function projectUsesTenancy(baseDir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(baseDir, 'package.json'), 'utf8')) as Record<string, unknown>
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field]
      if (deps && typeof deps === 'object' && Object.keys(deps).some((dep) => TENANCY_PACKAGES.test(dep))) {
        return true
      }
    }
  } catch {
    // no package.json / not JSON: not detectably multi-tenant
  }
  return false
}

/**
 * CLI commands: `basalt make:resource Project`, `basalt make:service Project`, …
 * Options: --dir=<path> (target root), --force (overwrite),
 * --prisma (Prisma-backed repository + schema.prisma model),
 * --soft-delete (deletedAt column + restore() + restore route),
 * --no-register (skip wiring the resource into src/app.ts),
 * --public / --no-auth (deliberately PUBLIC routes; by default every route
 * requires an authenticated user), --tenant / --no-tenant (force tenant
 * scoping on/off; by default it is on when the project depends on
 * `@basaltkit/tenancy`).
 *
 * After generating, a security note states whether the routes are
 * authenticated and whether the data is tenant-scoped.
 *
 * `defaults` holds what is true of the project rather than of one invocation —
 * which Prisma client the repositories are typed against, and whether they are
 * Prisma-backed at all:
 *
 * ```ts
 * generatorCommands({
 *   prisma: true,
 *   prismaClient: { import: '../../tenant-db.js', type: 'TenantDb' },
 * })
 * ```
 *
 * A flag still wins, in both directions: `--no-prisma` turns off a default of
 * `prisma: true`. A default a flag cannot override is a trap, and the CLI's
 * argv parser already gives the negation its own value.
 */
export function generatorCommands(defaults: GeneratorOptions = {}): CommandDefinition[] {
  return specs().map((spec) =>
    defineCommand({
      name: spec.command,
      description: spec.describe,
      async handle({ args, flags, io }) {
        const name = args[0]
        if (!name) {
          io.error(
            `Usage: basalt ${spec.command} <Name> [--dir=<path>] [--force] [--prisma] [--soft-delete] [--public] [--tenant|--no-tenant]`,
          )
          return 1
        }
        const options = {
          ...(typeof flags['dir'] === 'string' ? { baseDir: flags['dir'] } : {}),
          force: flags['force'] === true,
        }
        // `flags[x] === true` alone would let a default of `true` survive
        // `--no-prisma`: the flag is only consulted when it was actually given.
        const flagOr = (flag: string, fallback: boolean | undefined): boolean =>
          typeof flags[flag] === 'boolean' ? flags[flag] : (fallback ?? false)
        // Secure by default: auth is on unless explicitly turned off; tenant
        // scoping follows the project's dependencies unless explicitly set.
        const tenantDefault = defaults.tenant ?? (await projectUsesTenancy(resolve(options.baseDir ?? process.cwd())))
        const genOptions: GeneratorOptions = {
          ...defaults,
          prisma: flagOr('prisma', defaults.prisma),
          softDelete: flagOr('soft-delete', defaults.softDelete),
          // `--public` is the named opt-out; `--no-auth` (parsed as auth: false)
          // is accepted too, as are the literal negation keys programmatic
          // callers may pass.
          auth:
            flags['public'] === true || flags['no-auth'] === true ? false : flagOr('auth', defaults.auth ?? true),
          tenant: flags['no-tenant'] === true ? false : flagOr('tenant', tenantDefault),
        }
        try {
          const written = await writeGenerated(spec.build(name, genOptions), options)
          io.log(`Generated ${written.length} file(s):`)
          for (const path of written) io.log(`  ${path}`)
          if (spec.secured) {
            io.log('Security:')
            io.log(
              genOptions.auth
                ? '  Routes require an authenticated user (meta.auth) — register authPlugin; the app refuses to boot otherwise.'
                : '  PUBLIC: routes were generated with --public and accept anonymous callers.',
            )
            io.log(
              genOptions.tenant
                ? `  Data is tenant-scoped via requireTenantId() (no tenant → 400)${genOptions.prisma ? '; the model has an indexed tenantId column — migrate it.' : '.'}`
                : '  Data is NOT tenant-scoped — shared by every tenant. Use --tenant if this resource belongs to a tenant.',
            )
            io.log('  Add authorization (who may read/write which rows) before shipping.')
          }

          // `--no-register` now parses as `register: false` (cli parseArgv negation);
          // the legacy literal key stays accepted for programmatic callers.
          if (spec.register && flags['register'] !== false && flags['no-register'] !== true) {
            const result = await registerResourceInApp(name, options)
            if (result.registered) {
              io.log('Wired the plugin + routes into src/app.ts.')
            } else if (result.reason === 'already registered') {
              io.log('Already wired into src/app.ts — left it as is.')
            } else {
              io.log(`Could not auto-wire src/app.ts (${result.reason}).`)
              io.log('Add the plugin to `plugins` and the routes to `fastifyPlugin({ routes })` yourself.')
            }
          }
          return 0
        } catch (error) {
          if (error instanceof FileExistsError) {
            io.error(error.message)
            return 1
          }
          throw error
        }
      },
    }),
  )
}
