import type { Container, MachizeApp } from '@machize/core'

/** Output surface — swappable in tests to capture what a command prints. */
export interface CommandIo {
  log(message: string): void
  error(message: string): void
  table(rows: Record<string, unknown>[]): void
}

export interface CommandContext {
  app: MachizeApp
  container: Container
  io: CommandIo
  /** Positional arguments after the command name. */
  args: string[]
  /** Parsed flags: `--key=value` → string, `--flag` → true. */
  flags: Record<string, string | boolean>
}

export interface CommandDefinition {
  /** Command name, by convention `noun:verb` (e.g. `tenant:migrate`). */
  name: string
  description?: string
  handle(context: CommandContext): void | number | Promise<void | number>
}

export function defineCommand(command: CommandDefinition): CommandDefinition {
  return command
}
