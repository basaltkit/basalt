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
 * --no-register (skip wiring the resource into src/app.ts).
 */
export function generatorCommands(): CommandDefinition[] {
  return specs().map((spec) =>
    defineCommand({
      name: spec.command,
      description: spec.describe,
      async handle({ args, flags, io }) {
        const name = args[0]
        if (!name) {
          io.error(`Usage: basalt ${spec.command} <Name> [--dir=<path>] [--force] [--prisma]`)
          return 1
        }
        const options = {
          ...(typeof flags['dir'] === 'string' ? { baseDir: flags['dir'] } : {}),
          force: flags['force'] === true,
        }
        const genOptions: GeneratorOptions = { prisma: flags['prisma'] === true }
        try {
          const written = await writeGenerated(spec.build(name, genOptions), options)
          io.log(`Generated ${written.length} file(s):`)
          for (const path of written) io.log(`  ${path}`)

          if (spec.register && flags['no-register'] !== true) {
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
