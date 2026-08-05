import { ensureMetadata, type MachizeApp } from '@machize/core'
import { builtinCommands } from './builtins.js'
import type { CommandDefinition, CommandIo } from './command.js'
import { consoleIo } from './io.js'
import { parseArgv } from './parse.js'

export interface RunCliOptions {
  app: MachizeApp
  /** Defaults to process.argv.slice(2). */
  argv?: string[]
  /** Defaults to console output — swap in tests. */
  io?: CommandIo
}

/**
 * Boots the app, resolves the command (built-ins + everything registered in
 * the 'commands' metadata bucket), runs it and shuts the app down.
 * Returns the process exit code instead of calling process.exit — the bin
 * wrapper decides what to do with it.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  const { app } = options
  const io = options.io ?? consoleIo()
  const { command, args, flags } = parseArgv(options.argv ?? process.argv.slice(2))

  if (app.phase === 'created') await app.boot()
  try {
    const registered = ensureMetadata(app.container).get<CommandDefinition>('commands')
    const commands = [...builtinCommands(), ...registered]

    if (command === undefined || command === 'list') {
      io.log('Available commands:')
      io.table(
        commands.map(({ name, description }) => ({ command: name, description: description ?? '' })),
      )
      return 0
    }

    const found = commands.find((candidate) => candidate.name === command)
    if (!found) {
      io.error(`Unknown command "${command}". Run "mach list" to see what is available.`)
      return 1
    }

    const code = await found.handle({ app, container: app.container, io, args, flags })
    return code ?? 0
  } finally {
    await app.shutdown()
  }
}
