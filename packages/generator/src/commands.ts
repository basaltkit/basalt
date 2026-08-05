import { defineCommand, type CommandDefinition } from '@machize/cli'
import {
  FileExistsError,
  GENERATORS,
  generate,
  generateResource,
  writeGenerated,
  type GeneratorKind,
} from './generate.js'

interface MakeSpec {
  command: string
  describe: string
  build: (name: string) => Parameters<typeof writeGenerated>[0]
}

function specs(): MakeSpec[] {
  return [
    { command: 'make:resource', describe: 'Generate a full resource vertical', build: generateResource },
    ...(Object.keys(GENERATORS) as GeneratorKind[]).map((kind) => ({
      command: `make:${kind}`,
      describe: `Generate a ${kind} file`,
      build: (name: string) => [generate(kind, name)],
    })),
  ]
}

/**
 * CLI commands: `mach make:resource Project`, `mach make:service Project`, …
 * Options: --dir=<path> (target root), --force (overwrite).
 */
export function generatorCommands(): CommandDefinition[] {
  return specs().map((spec) =>
    defineCommand({
      name: spec.command,
      description: spec.describe,
      async handle({ args, flags, io }) {
        const name = args[0]
        if (!name) {
          io.error(`Usage: mach ${spec.command} <Name> [--dir=<path>] [--force]`)
          return 1
        }
        const options = {
          ...(typeof flags['dir'] === 'string' ? { baseDir: flags['dir'] } : {}),
          force: flags['force'] === true,
        }
        try {
          const written = await writeGenerated(spec.build(name), options)
          io.log(`Generated ${written.length} file(s):`)
          for (const path of written) io.log(`  ${path}`)
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
