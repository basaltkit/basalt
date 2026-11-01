import type { Container, BasaltApp } from '@basaltkit/core'

/** Output surface — swappable in tests to capture what a command prints. */
export interface CommandIo {
  log(message: string): void
  error(message: string): void
  table(rows: Record<string, unknown>[]): void
  /** Ask a yes/no question. Resolves true only on an explicit yes. */
  confirm(question: string): Promise<boolean>
}

export interface CommandContext {
  app: BasaltApp
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
  /** One line for `basalt list`. Keep the arguments out of it: they go in `usage`. */
  description?: string
  /**
   * What follows the name on the command line, for `basalt help <name>`:
   * `'<id> [--force] [--yes]'` prints `Usage: basalt tenant:destroy <id> [--force] [--yes]`.
   */
  usage?: string
  /** Flag → what it does, for `basalt help <name>`: `{ '--yes': 'Skip the confirmation' }`. */
  flags?: Record<string, string>
  handle(context: CommandContext): void | number | Promise<void | number>
}

export function defineCommand(command: CommandDefinition): CommandDefinition {
  return command
}
