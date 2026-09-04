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
    },
    ...(Object.keys(GENERATORS) as GeneratorKind[]).map((kind) => ({
      command: `make:${kind}`,
      describe: `Generate a ${kind} file`,
      build: (name: string, options: GeneratorOptions) => [generate(kind, name, options)],
    })),
  ]
}

/**
 * CLI commands: `basalt make:resource Project`, `basalt make:service Project`, …
 * Options: --dir=<path> (target root), --force (overwrite),
 * --prisma (Prisma-backed repository + schema.prisma model),
 * --soft-delete (deletedAt column + restore() + restore route),
 * --no-register (skip wiring the resource into src/app.ts).
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
            `Usage: basalt ${spec.command} <Name> [--dir=<path>] [--force] [--prisma] [--soft-delete]`,
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
        const genOptions: GeneratorOptions = {
          ...defaults,
          prisma: flagOr('prisma', defaults.prisma),
          softDelete: flagOr('soft-delete', defaults.softDelete),
        }
        try {
          const written = await writeGenerated(spec.build(name, genOptions), options)
          io.log(`Generated ${written.length} file(s):`)
          for (const path of written) io.log(`  ${path}`)

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
