import { ensureMetadata, type BasaltApp } from '@basaltkit/core'
import { builtinCommands } from './builtins.js'
import type { CommandDefinition, CommandIo } from './command.js'
import { consoleIo } from './io.js'
import { parseArgv } from './parse.js'

/** Commands create-basalt serves (bin/basalt.ts forwards them before booting the app). */
const PROJECT_COMMANDS = ['update', 'add', 'doctor', 'info']

export interface RunCliOptions {
  app: BasaltApp
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
    const shadowed = shadowedCommands(commands)

    if (command === undefined || command === 'list') {
      io.log('Available commands:')
      io.table(
        commands
          .filter((candidate) => !shadowed.includes(candidate))
          .map(({ name, description }) => ({ command: name, description: description ?? '' })),
      )
      for (const name of new Set(shadowed.map((candidate) => candidate.name))) warnShadowed(io, commands, name)
      return 0
    }

    const found = commands.find((candidate) => candidate.name === command)
    if (!found) {
      io.error(`Unknown command "${command}". Run "basalt list" to see what is available.`)
      if (PROJECT_COMMANDS.includes(command)) {
        // A bin/basalt.ts generated before the project commands existed: they
        // live in create-basalt, which also patches this file.
        io.error(`"${command}" is a project command of create-basalt: run \`npx create-basalt@latest ${command}\` (its \`update\` also teaches this bin/basalt.ts to forward it).`)
      }
      return 1
    }

    if (shadowed.some((candidate) => candidate.name === command)) warnShadowed(io, commands, command)

    const code = await found.handle({ app, container: app.container, io, args, flags })
    return code ?? 0
  } finally {
    await app.shutdown()
  }
}

/** Every command that a same-named, earlier-registered command hides. */
function shadowedCommands(commands: CommandDefinition[]): CommandDefinition[] {
  const seen = new Set<string>()
  return commands.filter((candidate) => {
    if (seen.has(candidate.name)) return true
    seen.add(candidate.name)
    return false
  })
}

/**
 * The first registration of a name wins and the others never run. Said out
 * loud, because a silently ignored command reads as a broken one — e.g.
 * tenancyPlugin's own `tenant:migrate` hiding @basaltkit/prisma's
 * tenantMigrateCommand passed in bin/basalt.ts.
 */
function warnShadowed(io: CommandIo, commands: CommandDefinition[], name: string): void {
  const [winner, ...hidden] = commands.filter((candidate) => candidate.name === name)
  const describe = (candidate: CommandDefinition): string => (candidate.description ? `"${candidate.description}"` : '(no description)')
  io.error(
    `"${name}" is registered ${hidden.length + 1} times: the first, ${describe(winner!)}, runs; ` +
      `ignored: ${hidden.map(describe).join(', ')}. Drop or rename the duplicate.`,
  )
}
